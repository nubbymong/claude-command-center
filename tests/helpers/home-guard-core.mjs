// Home guard: tests and probes never act on a real home.
//
// One implementation, two entry points:
//   - tests/helpers/home-isolation.ts (vitest setupFiles[0]) points the home
//     variables at a per-worker folder and installs the guard;
//   - tests/helpers/probe-guard.mjs (`node --import`) installs the same guard in a
//     plain-node probe or fake CLI. Every node child of a guarded process loads it
//     too: the spawn check adds `--import=<probe-guard URL>` to the child's
//     NODE_OPTIONS, and the child removes it from its own view at start.
// Plain JS so node can load it without a TypeScript loader.
//
// Real homes: the original HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
// CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_{CONFIG,DATA,STATE,CACHE}_HOME and
// HOMEDRIVE+HOMEPATH, os.homedir(), os.userInfo().homedir (which ignores the
// environment), and any account-profiles folder above one of them. A path is inside
// a real home when it is under one of them and not under a more specific allowed
// root: the isolated root, the temp folder (on Windows it sits under LOCALAPPDATA), a
// CI runner's RUNNER_TEMP in the runner layout (<work>/_temp beside the checkout), or
// the project root (CI runners keep the checkout under HOME). Only the isolated root
// wins a tie.
//
// Covered (each throws TEST_ISOLATION_VIOLATION and is recorded, so a refusal the
// caller swallows still fails the test, or the probe's exit code):
//   - the fs entry points in the tables below (sync, callback and fs.promises),
//     opens and reads whose flags are not read-only, the fd and FileHandle
//     metadata and write calls on a real-home file opened read-only, and a
//     recursive copy into a folder holding a link into a real home;
//   - child_process spawn/spawnSync/exec/execSync/execFile/execFileSync/fork,
//     ChildProcess.prototype.spawn and node-pty spawn: the working folder, the
//     child environment exactly as Node and libuv build it (home, temp, XDG,
//     GIT_CONFIG_GLOBAL, npm_config_* and the Claude / Codex / app config-folder
//     values in CONFIG_HOME_VARS), and the paths written literally in the arguments
//     (drive, UNC, MSYS, Cygwin incl. /proc/cygdrive, and WSL spellings, `~user`,
//     globs, values after `=`, embedded in longer strings); and in a shell line
//     (exec, shell:true, `cmd /c|/k`, `sh|bash|dash|zsh|ksh -c`, and
//     `pwsh|powershell -c|-Command`) a `cd` / `chdir` / `pushd` (glued forms such as
//     `cd/d`, `cd\`, `cd..` included) or `Set-Location` / `sl` / `Push-Location` into
//     or above a real home, a filesystem root that holds one included. Not refused: the
//     executable itself; the running node binary (that exact spelling) as the command
//     word of a command line written in an argument or of a shell line (a git hook
//     command), never as an operand; and a node script, or the command word (that
//     position only) of a `cmd /c` / `sh -c` line, inside a real home's npm or nvm
//     folder. A child env that omits a home or temp variable gets it filled in, and a
//     RUNNER_TEMP a caller sets in it is checked like TEMP;
//   - worker_threads Workers: one whose script is in this project's node_modules (a
//     toolchain worker such as esbuild's) starts guarded, without preloads in its
//     execArgv (one the caller names is refused), every other one is refused;
//     process.execve and process.binding('fs' | 'fs_dir' | 'spawn_sync' |
//     'process_wrap') are refused.
// Paths are compared after resolving `..` (on POSIX also physically, from a link's
// target, as the kernel reads it; both readings are checked), separators, case
// (win32, darwin), trailing dots and spaces, stream suffixes, `\\?\` `\\.\` `\??\` prefixes, file:
// URLs and URL-like objects, Buffers, and the real path of the nearest existing
// ancestor (a link out of an allowed folder is followed; a volume-GUID path is
// mapped to its drive). UNC paths other than `\\.\pipe\` and unmappable device
// paths fail closed. An operation on the folder entry itself (unlink, rm, rmdir,
// rename, lchmod, lchown, lutimes) does not follow a link that is the last component,
// written without a trailing separator: it removes, moves or touches the link, never
// what it points at. Any other entry is checked by its real path as well.
//
// NOT covered: native addons (better-sqlite3 and node-pty write natively); a child
// that is not node beyond its environment, working folder and arguments (a native
// tool that finds the profile through the OS rather than the environment, e.g. to
// expand `~`, reaches the real one); a process started without going through these
// entry points; shell re-assembly of an argument: quotes or carets inside a word,
// `%VAR%` / `$VAR` expansion, a PowerShell `-EncodedCommand`, and a relative path after
// a `cd` the scanner did not see are NOT read the way the shell will read them; a
// recursive delete is left to Node, which does not follow links; a refusal inside a
// toolchain worker fails that worker's call but is not recorded in the test's thread.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import childProcess from 'node:child_process'
import workerThreads from 'node:worker_threads'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VIOLATION_CODE = 'TEST_ISOLATION_VIOLATION'
export const MARKER_ENV = 'CCC_HOME_GUARD'
export const HOME_VARS = Object.freeze(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
export const XDG_VARS = Object.freeze(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'])
const TEMP_VARS = Object.freeze(['TEMP', 'TMP', 'TMPDIR'])
const IS_WIN = process.platform === 'win32'
// Filled into a child environment that omits them. CLAUDE_CONFIG_DIR is left unset
// on purpose: unset it falls back to the filled HOME, and the launch code that
// strips it is tested through a real child.
const FILL_VARS = Object.freeze(
  IS_WIN
    ? ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME']
    : ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', ...XDG_VARS],
)
// Absent from a child environment, these send the child to the OS profile.
const FALLBACK_VARS = Object.freeze(IS_WIN ? ['HOME', 'APPDATA', 'LOCALAPPDATA'] : ['HOME'])
// libuv copies these from the live process environment into a Windows child
// environment that omits them.
const LIBUV_REQUIRED = Object.freeze(IS_WIN ? ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP'] : [])
const STATE_KEY = Symbol.for('ccc.test-home-guard.state')
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PROBE_GUARD_URL = pathToFileURL(path.join(PROJECT_ROOT, 'tests', 'helpers', 'probe-guard.mjs')).href
const NODE_OPTIONS_IMPORT = `--import=${PROBE_GUARD_URL}`
// The only variables a fresh probe environment copies from its caller.
const PROBE_ENV_KEEP = Object.freeze(['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM'])
const BINDINGS_REFUSED = Object.freeze(['fs', 'fs_dir', 'spawn_sync', 'process_wrap'])
const TREE_LIMIT = 20000
// Variables that send git or npm to a config, cache or prefix folder: checked in a child
// environment, and in the vitest entry pointed into the isolated home when they name a
// real one (npm puts its npm_config_* into every script it runs).
// Folders the app, Claude or Codex read their configuration, credentials or caches from
// (src/main/account-profiles.ts and the providers set them for a launch): their
// original values are real roots too, and like the git/npm ones they are checked in a
// child environment and pointed into the isolated home in each worker.
export const CONFIG_HOME_VARS = Object.freeze([
  'ANTHROPIC_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_FEDERATION_CACHE_DIR', 'CODEX_SQLITE_HOME', 'CCC_CONFIG_DIR',
])
const CONFIG_REDIRECT = new RegExp(`^(?:GIT_CONFIG_GLOBAL|npm_config_.+|${CONFIG_HOME_VARS.join('|')})$`, 'i')
// Bounds for checking arguments: path depth that is resolved through the filesystem,
// and candidate paths per argument that get the full (realpath) check; the rest get
// the lexical check only.
const MAX_REAL_DEPTH = 64
// Links one path resolution may follow in all (Linux allows 40 in one lookup).
const LINK_BUDGET = 40
const FULL_CHECKS_PER_ARG = 256

export class TestIsolationViolation extends Error {
  /** @param {string} op @param {string} target @param {string} root @param {string} [reason] */
  constructor(op, target, root, reason) {
    super(
      `${VIOLATION_CODE}: ${op} refused: ${target} ${reason ?? 'resolves inside a real home'} (${root}). ` +
        'Tests and probes never act on a real home: use os.homedir() / os.tmpdir(), which point at an isolated folder.',
    )
    this.name = 'TestIsolationViolation'
    this.code = VIOLATION_CODE
    this.op = op
    this.target = target
    this.root = root
  }
}

// ---------------------------------------------------------------------------
// Path normalisation (pure; the platform is a parameter so the win32 rules are
// testable on any host).

/** @param {string} platform */
function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** @param {string} platform */
function foldsCase(platform) {
  return platform === 'win32' || platform === 'darwin'
}

/** @param {unknown} v @returns {v is string} */
function nonEmpty(v) {
  return typeof v === 'string' && v.length > 0
}

/**
 * Every string a path argument can stand for: a string (and, for a `file:` string,
 * the URL reading too), a URL or URL-like object read the way Node's fs reads it
 * (fileURLToPath of the object: hostname and pathname) and through its href, or a
 * Buffer / Uint8Array. Anything else (a descriptor, a FileHandle) is not a path.
 * @param {unknown} input @param {string} platform @returns {string[]}
 */
function pathStrings(input, platform) {
  const windows = platform === 'win32'
  if (typeof input === 'string') {
    const out = [input]
    if (/^file:/i.test(input)) {
      try {
        out.push(fileURLToPath(input, { windows }))
      } catch {
        /* not a file URL */
      }
    }
    return out
  }
  if (input instanceof Uint8Array) return [Buffer.from(input).toString('utf8')]
  if (input && typeof input === 'object' && /** @type {any} */ (input).href) {
    /** @type {string[]} */ const out = []
    try {
      out.push(fileURLToPath(/** @type {any} */ (input), { windows }))
    } catch {
      /* not URL-like for Node either */
    }
    try {
      out.push(fileURLToPath(String(/** @type {any} */ (input).href), { windows }))
    } catch {
      /* href is not a file URL */
    }
    return out
  }
  return []
}

/**
 * Absolute, lexically normalised forms of `str` (original case). `device` means a
 * Win32 path the guard cannot map to a drive (a UNC share, a volume or device
 * path); callers treat it as a violation (fail closed). A named pipe is no path.
 * A volume-GUID path is returned in `volume` so a caller with a filesystem can map it
 * to its drive first.
 * @param {string} str @param {string} base @param {string} platform
 * @returns {{ forms: string[], device: boolean, volume?: string }}
 */
function lexicalForms(str, base, platform) {
  const P = pathApi(platform)
  if (platform !== 'win32') return { forms: [P.resolve(base, str)], device: false }
  let s = str.replace(/\//g, '\\')
  for (let i = 0; i < 4; i++) {
    const m = /^(?:\\\\[?.]\\|\\\?\?\\)/.exec(s)
    if (!m) break
    const rest = s.slice(m[0].length)
    if (/^[a-z]:(?:\\|$)/i.test(rest)) s = rest.length === 2 ? rest + '\\' : rest
    else if (/^unc\\/i.test(rest)) s = '\\\\' + rest.slice(4)
    else if (/^(?:pipe\\|nul$)/i.test(rest)) return { forms: [], device: false }
    else if (/^volume\{[0-9a-f-]+\}(?:\\|$)/i.test(rest)) return { forms: [], device: true, volume: '\\\\?\\' + rest }
    else return { forms: [], device: true }
  }
  const abs = P.resolve(base, s)
  const root = P.parse(abs).root
  // Any UNC path (\\host\share\..., an administrative share included) fails closed.
  if (root.startsWith('\\\\')) return { forms: [], device: true }
  const comps = abs.slice(root.length).split('\\').filter((c) => c.length > 0)
  /** @type {string[]} */ const asParent = []
  /** @type {string[]} */ const asSelf = []
  let ambiguous = false
  for (const raw of comps) {
    // `name:stream` is a stream of `name`; Win32 drops trailing dots and spaces.
    const noStream = raw.split(':')[0]
    const trimmed = noStream.replace(/[. ]+$/, '')
    if (trimmed) {
      asParent.push(trimmed)
      asSelf.push(trimmed)
    } else if (noStream.startsWith('..')) {
      ambiguous = true
      asParent.push('..')
      asSelf.push('.')
    } else {
      asParent.push('.')
      asSelf.push('.')
    }
  }
  const forms = [P.resolve(root, ...asParent)]
  if (ambiguous) forms.push(P.resolve(root, ...asSelf))
  return { forms, device: false }
}

/**
 * The real path of `abs`: the realpath of its nearest existing ancestor with the
 * missing tail appended; a dangling link is followed through its target. Returns
 * null when a link leads somewhere the guard cannot map.
 * Every link followed in one resolution (a dangling link's target, the physical `..` walk
 * on POSIX) draws on one shared budget, so a link loop costs at most LINK_BUDGET steps.
 * @param {string} abs @param {FsImpl} fsImpl @param {string} platform @param {{ left: number }} [budget]
 * @returns {string | null}
 */
function resolveReal(abs, fsImpl, platform, budget = { left: LINK_BUDGET }) {
  const P = pathApi(platform)
  /** @type {string[]} */ const tail = []
  const withTail = (/** @type {string} */ head) => (tail.length ? P.join(head, ...[...tail].reverse()) : head)
  let cur = abs
  for (;;) {
    let st
    try {
      st = fsImpl.lstatSync(cur, { throwIfNoEntry: false })
    } catch {
      st = undefined
    }
    if (st) {
      let real
      try {
        real = fsImpl.realpathSync(cur)
      } catch {
        real = undefined
      }
      if (typeof real === 'string') return withTail(real)
      if (st.isSymbolicLink() && budget.left > 0) {
        budget.left--
        let target
        try {
          target = fsImpl.readlinkSync(cur)
        } catch {
          target = undefined
        }
        if (typeof target === 'string') {
          const lf = lexicalFormsFs(target, P.dirname(cur), platform, fsImpl, { budget })
          if (lf.device) return null
          if (lf.forms.length > 0) {
            const r = resolveReal(lf.forms[0], fsImpl, platform, budget)
            return r === null ? null : withTail(r)
          }
        }
      }
    }
    const parent = P.dirname(cur)
    if (parent === cur) return abs
    tail.push(P.basename(cur))
    cur = parent
  }
}

/**
 * The drive path a `\\?\Volume{GUID}\...` path stands for: the realpath of its nearest
 * existing ancestor (Windows maps a mounted volume to its drive) with the rest
 * appended, or null when the volume has no drive.
 * @param {string} volume @param {FsImpl} fsImpl
 */
function mapVolume(volume, fsImpl) {
  const m = /^(\\\\\?\\volume\{[0-9a-f-]+\})((?:\\[^\\]*)*)$/i.exec(volume)
  if (!m) return null
  const rest = m[2].split('\\').filter(Boolean)
  for (let k = rest.length; k >= 0 && rest.length - k < MAX_REAL_DEPTH; k--) {
    let real
    try {
      real = fsImpl.realpathSync(m[1] + '\\' + rest.slice(0, k).join('\\'))
    } catch {
      real = undefined
    }
    if (typeof real !== 'string') continue
    const drive = real.replace(/^\\\\\?\\/, '')
    if (!/^[a-z]:(?:\\|$)/i.test(drive)) return null
    return path.win32.join(drive.length === 2 ? drive + '\\' : drive, ...rest.slice(k))
  }
  return null
}

/**
 * POSIX resolves `..` physically: after a link, `..` is the parent of the link's TARGET
 * (`/tmp/link/../x` with link -> /home/u/sub is /home/u/x). The path with each `..`
 * applied to the real path of what precedes it; null when it has no `..`, or more than
 * `maxDotDots` of them (an argument scan keeps those lexical), or the walk leads where
 * the guard cannot map. Windows resolves `..` lexically, as lexicalForms does.
 * @param {string} str @param {string} base @param {string} platform @param {FsImpl} fsImpl
 * @param {{ left: number }} budget @param {number} maxDotDots @returns {string | null}
 */
function physicalDotDot(str, base, platform, fsImpl, budget, maxDotDots) {
  const P = pathApi(platform)
  const comps = (str.startsWith('/') ? str : `${base}/${str}`).split('/')
  const dotDots = comps.filter((c) => c === '..').length
  if (dotDots === 0 || dotDots > maxDotDots) return null
  let cur = '/'
  for (const c of comps) {
    if (!c || c === '.') continue
    if (c !== '..') {
      cur = P.join(cur, c)
      continue
    }
    const real = resolveReal(cur, fsImpl, platform, budget)
    if (real === null) return null
    cur = P.dirname(real)
  }
  return cur
}

/**
 * lexicalForms, with a volume-GUID path mapped to its drive first; on POSIX also the
 * physical reading of `..` (both forms are checked, so the stricter one wins).
 * @param {string} str @param {string} base @param {string} platform @param {FsImpl} fsImpl
 * @param {{ budget?: { left: number }, maxDotDots?: number }} [opts]
 */
function lexicalFormsFs(str, base, platform, fsImpl, opts = {}) {
  if (platform !== 'win32') {
    const lexical = pathApi(platform).resolve(base, str)
    const physical = physicalDotDot(str, base, platform, fsImpl, opts.budget ?? { left: LINK_BUDGET }, opts.maxDotDots ?? Infinity)
    return { forms: physical !== null && physical !== lexical ? [lexical, physical] : [lexical], device: false }
  }
  const lf = lexicalForms(str, base, platform)
  if (!lf.volume) return lf
  const mapped = mapVolume(lf.volume, fsImpl)
  return mapped === null ? lf : lexicalForms(mapped, base, platform)
}

/** @param {string} p @param {string} platform */
function keyOf(p, platform) {
  const P = pathApi(platform)
  const root = P.parse(p).root
  let s = p
  while (s.length > root.length && s.endsWith(P.sep)) s = s.slice(0, -1)
  return foldsCase(platform) ? s.toLowerCase() : s
}

/** @param {string} k @param {string} rootKey @param {string} sep */
function within(k, rootKey, sep) {
  return k === rootKey || k.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep)
}

/**
 * @typedef {{ lstatSync: Function, realpathSync: Function, readlinkSync: Function, readdirSync?: Function }} FsImpl
 * @typedef {{ path: string, kind: 'isolated' | 'tmp' | 'project' }} AllowedRoot
 * @typedef {{ root: string, form: string, reason?: string, device?: boolean }} Hit
 */

/** @type {FsImpl} */
const REAL_FS = {
  lstatSync: fs.lstatSync,
  realpathSync: fs.realpathSync.native,
  readlinkSync: fs.readlinkSync,
  readdirSync: fs.readdirSync,
}

/**
 * The account-profiles folder above each root, if any: sibling profiles are as real
 * as the one in use.
 * @param {string[]} roots @param {string} [platform]
 */
export function deriveAccountProfilesRoots(roots, platform = process.platform) {
  const P = pathApi(platform)
  /** @type {string[]} */ const out = []
  for (const r of roots) {
    const abs = P.resolve(r)
    const root = P.parse(abs).root
    const comps = abs.slice(root.length).split(P.sep)
    const i = comps.findIndex((c) => c.toLowerCase() === 'account-profiles')
    if (i >= 0) out.push(P.join(root, ...comps.slice(0, i + 1)))
  }
  return [...new Set(out)]
}

// Characters that end a path inside an argument (a JSON array, an assignment, a
// shell line). '[' and '{' are glob characters, not terminators.
const TERM_WIN = ' \t\r\n"\'`=,;|&<>()]}'
const TERM_POSIX = TERM_WIN + ':'
const GLOB_CHARS = /[*?[{]/

/**
 * A pure checker over explicit roots. The installed guard is one of these; tests
 * build their own with simulated roots and a fake fs.
 * @param {{ realRoots: string[], allowedRoots?: AllowedRoot[], installRoots?: string[], userNames?: string[],
 *   executables?: string[], platform?: string, fsImpl?: FsImpl, cwd?: () => string }} opts
 *   `executables`: binaries that may be the command word of a command line written in an
 *   argument even inside a real home (the running node, which macOS runners keep under
 *   HOME and tests hand to git hooks): that exact spelling, in that position only
 */
export function createHomeChecker(opts) {
  const platform = opts.platform ?? process.platform
  const fsImpl = opts.fsImpl ?? REAL_FS
  const cwd = opts.cwd ?? (() => process.cwd())
  const P = pathApi(platform)
  const sep = P.sep
  const win = platform === 'win32'
  const fold = foldsCase(platform)
  const TERM = win ? TERM_WIN : TERM_POSIX

  /**
   * @typedef {{ memo?: Map<string, { device: boolean, forms: string[] }>, lexOnly?: boolean, full?: number,
   *   dirs?: Map<string, { exists: boolean, real: string | null }> }} ScanCtx
   *   one argument scan: forms are memoised, and past the full-check cap a candidate is
   *   resolved through its (memoised) folder instead of its own full walk
   */
  /** @param {string} s @param {string} base @param {ScanCtx} [ctx] @returns {{ device: boolean, forms: string[] }} */
  const formsOf = (s, base, ctx) => {
    const memoKey = ctx && ctx.memo ? `${ctx.lexOnly ? 'L' : 'F'}${base}\0${s}` : undefined
    if (memoKey !== undefined) {
      const hit = /** @type {Map<string, any>} */ (ctx?.memo).get(memoKey)
      if (hit) return hit
    }
    /** @type {{ device: boolean, forms: string[] }} */ let result
    // In an argument scan, past the full-check cap or with more `..` than any real depth,
    // `..` stays lexical (bounds the cost); fs calls always read it physically on POSIX.
    const lf = lexicalFormsFs(s, base, platform, fsImpl, ctx ? { maxDotDots: ctx.lexOnly ? 0 : MAX_REAL_DEPTH } : {})
    // In an argument scan, a candidate deeper than any real folder keeps its lexical
    // form (bounds the cost of a long token full of separators); past the candidate cap
    // its folder is resolved through the scan's folder memo (links in every folder above
    // it are still followed). fs calls always get the full walk.
    const deep = !!ctx && lf.forms.some((f) => f.split(/[\\/]/).length > MAX_REAL_DEPTH)
    if (lf.device) result = { device: true, forms: [] }
    else if (deep) result = { device: false, forms: lf.forms }
    else {
      const out = new Set(lf.forms)
      result = { device: false, forms: [] }
      for (const f of lf.forms) {
        const r = ctx && ctx.lexOnly ? realByFolder(f, ctx) : resolveReal(f, fsImpl, platform)
        const again = r === null ? null : lexicalFormsFs(r, base, platform, fsImpl)
        if (again === null || again.device) {
          result = { device: true, forms: [] }
          break
        }
        for (const g of again.forms) out.add(g)
      }
      if (!result.device) result = { device: false, forms: [...out] }
    }
    if (memoKey !== undefined) /** @type {Map<string, any>} */ (ctx?.memo).set(memoKey, result)
    return result
  }
  /**
   * The real path of a folder, memoised per argument scan: an existing folder is
   * realpath'd (a link is followed), a missing one is its parent's real path plus its
   * name, and everything below a missing folder is missing without a syscall. null when
   * a link leads somewhere the guard cannot map.
   * @param {string} dir @param {ScanCtx} ctx @returns {{ exists: boolean, real: string | null }}
   */
  const realFolder = (dir, ctx) => {
    const memo = (ctx.dirs ??= new Map())
    const known = memo.get(dir)
    if (known) return known
    /** @type {{ exists: boolean, real: string | null }} */ let res
    const parent = P.dirname(dir)
    const up = parent === dir ? null : realFolder(parent, ctx)
    if (up && (!up.exists || up.real === null)) res = { exists: false, real: up.real === null ? null : P.join(up.real, P.basename(dir)) }
    else {
      let st
      try {
        st = fsImpl.lstatSync(dir, { throwIfNoEntry: false })
      } catch {
        st = undefined
      }
      if (!st) res = { exists: false, real: up ? P.join(/** @type {string} */ (up.real), P.basename(dir)) : dir }
      else if (st.isSymbolicLink()) res = { exists: true, real: resolveReal(dir, fsImpl, platform) }
      else {
        let real
        try {
          real = fsImpl.realpathSync(dir)
        } catch {
          real = undefined
        }
        res = { exists: true, real: typeof real === 'string' ? real : dir }
      }
    }
    memo.set(dir, res)
    return res
  }
  /** A candidate's real path through its folder (the candidate itself is not lstat'ed). @param {string} f @param {ScanCtx} ctx */
  const realByFolder = (f, ctx) => {
    const parent = P.dirname(f)
    if (parent === f) return f
    const up = realFolder(parent, ctx)
    return up.real === null ? null : P.join(up.real, P.basename(f))
  }
  /** @param {string[]} list */
  const keysOf = (list) => {
    const out = new Set()
    for (const p of list.filter(nonEmpty)) for (const f of formsOf(p, cwd()).forms) out.add(keyOf(f, platform))
    return /** @type {string[]} */ ([...out])
  }

  const realKeys = keysOf(opts.realRoots)
  const installKeys = keysOf(opts.installRoots ?? [])
  // Exact spellings (on Windows also with forward slashes): never a normalised key, so a
  // stream suffix, a trailing dot or space, or a link is not the binary.
  const execSpell = (opts.executables ?? []).filter(nonEmpty).flatMap((e) => (platform === 'win32' ? [e, e.replace(/\\/g, '/')] : [e]))
  const sameSpell = (/** @type {string} */ a, /** @type {string} */ b) => (foldsCase(platform) ? a.toLowerCase() === b.toLowerCase() : a === b)
  const isExecWord = (/** @type {string} */ w) => execSpell.some((e) => sameSpell(e, w))
  /**
   * An argument with the running node binary blanked where it is the command word of a
   * command line: at the start of the argument, or of a value after `=` (a git hook such
   * as core.fsmonitor="<node>" "<script>" args), quoted or not, exactly that spelling and
   * followed by at least one more word. Anywhere else (an operand, a copy destination)
   * it is checked like any other path.
   * @param {string} el
   */
  const blankExecWords = (el) => {
    if (execSpell.length === 0) return el
    let out = el
    const starts = [0]
    for (let at = el.indexOf('='); at >= 0; at = el.indexOf('=', at + 1)) starts.push(at + 1)
    for (const s of starts) {
      const q = el[s] === '"' || el[s] === "'" ? el[s] : ''
      const from = s + q.length
      for (const e of execSpell) {
        const end = from + e.length
        if (!sameSpell(el.slice(from, end), e)) continue
        const after = q ? (el[end] === q ? end + 1 : -1) : end
        if (after < 0 || !/^\s+\S/.test(el.slice(after))) continue
        out = out.slice(0, from) + ' '.repeat(e.length) + out.slice(end)
        break
      }
    }
    return out
  }
  /** @type {{ key: string, kind: string }[]} */
  const allowed = []
  for (const a of opts.allowedRoots ?? []) {
    if (!a || !nonEmpty(a.path)) continue
    for (const k of keysOf([a.path])) allowed.push({ key: k, kind: a.kind })
  }
  const userNames = new Set((opts.userNames ?? []).filter(nonEmpty).map((n) => n.toLowerCase()))

  /** The real root that makes key `k` protected, or null. @param {string} k */
  const protectedBy = (k) => {
    let real = ''
    for (const r of realKeys) if (within(k, r, sep) && r.length > real.length) real = r
    if (!real) return null
    for (const a of allowed) {
      if (!within(k, a.key, sep)) continue
      // The more specific root wins; on a tie only the isolated root does.
      if (a.key.length > real.length || (a.key.length === real.length && a.kind === 'isolated')) return null
    }
    return real
  }

  /** @param {unknown} input @param {string} [base] @param {ScanCtx} [ctx] @returns {Hit | null} */
  const classify = (input, base, ctx) => {
    const b = base ?? cwd()
    for (const s of pathStrings(input, platform)) {
      const f = formsOf(s, b, ctx)
      if (f.device) return { root: '(UNC or device path)', form: s, reason: 'is a UNC or device path the guard cannot map', device: true }
      for (const form of f.forms) {
        const root = protectedBy(keyOf(form, platform))
        if (root) return { root, form }
      }
    }
    return null
  }

  /**
   * Like classify, for an operation on the folder entry itself (unlink, rm, rmdir,
   * rename, lchmod, lchown, lutimes): when the entry is a link, written without a
   * trailing separator, it is not followed, because the operation removes, moves or
   * touches the link, never what it points at. Its folder is resolved in full, so a path
   * through a link into a real home is still caught.
   * @param {unknown} input @param {string} [base] @returns {Hit | null}
   */
  const classifyEntry = (input, base) => {
    const b = base ?? cwd()
    for (const s of pathStrings(input, platform)) {
      // Written with a trailing separator, or ending in `.` or `..`, the path names what a
      // link points at (POSIX reads `link/` as `link/.`): check it the full way.
      if (/(?:^|[\\/])\.{1,2}$/.test(s) || (win ? /[\\/]$/ : /\/$/).test(s)) {
        const hit = classify(s, b)
        if (hit) return hit
        continue
      }
      const lf = lexicalFormsFs(s, b, platform, fsImpl)
      if (lf.device) return { root: '(UNC or device path)', form: s, reason: 'is a UNC or device path the guard cannot map', device: true }
      for (const form of lf.forms) {
        // Only an entry that IS a link (or junction) is left unfollowed. Any other entry,
        // or a missing one, is checked by its real path too, as classify does: an 8.3
        // alias of a home, or a subst or mapped drive root that is one, stays a home.
        let st
        try {
          st = fsImpl.lstatSync(form, { throwIfNoEntry: false })
        } catch {
          st = undefined
        }
        if (!st || !st.isSymbolicLink()) {
          const hit = classify(form, b)
          if (hit) return hit
          continue
        }
        const parent = P.dirname(form)
        /** @type {string[]} */ const candidates = [form]
        if (parent !== form) {
          const up = formsOf(parent, b)
          if (up.device) return { root: '(UNC or device path)', form: s, reason: 'is a UNC or device path the guard cannot map', device: true }
          for (const p of up.forms) candidates.push(P.join(p, P.basename(form)))
        }
        for (const c of candidates) {
          const root = protectedBy(keyOf(c, platform))
          if (root) return { root, form: c }
        }
      }
    }
    return null
  }

  /**
   * Is `p` the parent, or an ancestor, of a real root? A filesystem root counts only
   * with `roots` (a `cd` to it), not for a glob (`/*` in a script is no path).
   * @param {string} p @param {string} base @param {ScanCtx} [ctx] @param {boolean} [roots]
   */
  const coversReal = (p, base, ctx, roots = false) => {
    for (const s of pathStrings(p, platform)) {
      const f = formsOf(s, base, ctx)
      for (const form of f.forms) {
        const k = keyOf(form, platform)
        if (!roots && k === keyOf(P.parse(form).root, platform)) continue
        if (realKeys.some((r) => within(r, k, sep))) return true
      }
    }
    return false
  }

  /** @param {string} p @param {string} base */
  const inInstallRoot = (p, base) => {
    if (installKeys.length === 0) return false
    const f = formsOf(p, base)
    if (f.device || f.forms.length === 0) return false
    return f.forms.every((form) => installKeys.some((r) => within(keyOf(form, platform), r, sep)))
  }

  /** The drive spellings of an MSYS, Cygwin or WSL path (`/c/x`, `/cygdrive/c/x`, `/proc/cygdrive/c/x`, `/mnt/c/x`). @param {string} c */
  const msysForms = (c) => {
    if (!win) return []
    const m = /^[\\/](?:(?:proc[\\/])?cygdrive[\\/]|mnt[\\/])?([a-z])(?=[\\/]|$)(.*)$/i.exec(c)
    return m ? [`${m[1]}:\\${m[2].replace(/^[\\/]+/, '')}`] : []
  }

  /**
   * `~user` spellings (a shell resolves them from the user database, not from HOME).
   * A bare `~` expands from the child's own HOME, which the spawn check has already
   * filled or checked, so it is no real-home spelling.
   * @param {string} c @returns {string[] | null}
   */
  const tildeForms = (c) => {
    const m = /^~([A-Za-z0-9._-]+)(?=[\\/]|$)(.*)$/.exec(c)
    if (!m) return null
    const name = m[1].toLowerCase()
    /** @type {string[]} */ const roots = []
    for (const r of opts.realRoots.filter(nonEmpty)) {
      if (userNames.has(name) || P.basename(r).toLowerCase() === name) roots.push(r)
    }
    return roots.map((r) => r + m[2])
  }

  /**
   * Check one candidate path from an argument. A UNC or device result counts only for
   * the argument as written: an MSYS or `~user` reading is a guess (a `/v` switch read
   * as drive V: can land on a mapped network share), so only a real home counts there.
   * @param {string} c @param {string} base @returns {Hit | null}
   */
  const argCandidate = (/** @type {string} */ c, /** @type {string} */ base, /** @type {ScanCtx | undefined} */ ctx = undefined) => {
    if (!c) return null
    const tilde = tildeForms(c)
    const forms = [c, ...msysForms(c), ...(tilde ?? [])]
    for (const f of forms) {
      const literal = f === c
      const hit = classify(f, base, ctx)
      if (hit && (literal || !hit.device)) return hit
      // A glob whose fixed part is a real home, or the folder above one, expands into it.
      const noPrefix = f.replace(/^(?:\\\\[?.]\\|\/\/[?.]\/|\\\?\?\\)/, '')
      const g = GLOB_CHARS.exec(noPrefix)
      if (g) {
        const fixed = noPrefix.slice(0, g.index)
        const cut = Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\'))
        const dir = cut >= 0 ? fixed.slice(0, cut + 1) : ''
        if (dir) {
          const dHit = classify(dir, base, ctx)
          if (dHit && (literal || !dHit.device)) return { ...dHit, reason: 'is a glob into a real home' }
          if (coversReal(dir, base, ctx)) return { root: dir, form: f, reason: 'is a glob that can reach a real home' }
        }
      }
    }
    return null
  }

  /** Paths written anywhere in an argument: drive, UNC, MSYS/WSL, POSIX absolute, `~`. @param {string} el */
  const embeddedPaths = (el) => {
    const T = TERM.replace(/[\]\\^-]/g, '\\$&')
    const body = `[^${T}]*`
    /** @type {RegExp[]} */
    const res = win
      ? [
          new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${body}`, 'g'),
          // A UNC path starts a word (an escaped `C:\\Users\\x` in a script is no share).
          new RegExp(`(?<![^${T}])(?:\\\\\\\\|//)[^\\\\/${T}]+[\\\\/]${body}`, 'g'),
          new RegExp(`(?<![A-Za-z0-9_.~\\\\/-])/(?:(?:proc/)?cygdrive/|mnt/)?[A-Za-z](?=/|$|[${T}])${body}`, 'g'),
        ]
      : [new RegExp(`(?<![A-Za-z0-9_.~-])/${body}`, 'g')]
    res.push(new RegExp(`(?<![^${T}])~[A-Za-z0-9._-]*(?=[\\\\/]|$|[${T}])${body}`, 'g'))
    /** @type {string[]} */ const out = []
    for (const re of res) for (const m of el.matchAll(re)) out.push(m[0])
    return out
  }

  // Each real root as it can be written: drive form, MSYS / Cygwin / WSL forms, and
  // (for a UNC share) the path below the drive. Normalised: '/' separators, folded.
  const spellings = realKeys.flatMap((k) => {
    const n = k.replace(/\\/g, '/')
    const m = /^([a-z]):(\/.*)?$/i.exec(n)
    if (!win || !m) return [{ v: n, kind: 'path' }]
    const rest = m[2] ?? ''
    if (!rest || rest === '/') return [{ v: n, kind: 'path' }]
    const d = m[1].toLowerCase()
    return [
      { v: n, kind: 'path' },
      { v: `/${d}${rest}`, kind: 'msys' },
      { v: `/cygdrive/${d}${rest}`, kind: 'msys' },
      { v: `/proc/cygdrive/${d}${rest}`, kind: 'msys' },
      { v: `/mnt/${d}${rest}`, kind: 'msys' },
      { v: rest, kind: 'unc' },
    ]
  })

  /**
   * Real-root spellings inside an argument, roots with spaces included. Linear in the
   * argument: no slice per occurrence.
   * @param {string} el @param {(c: string) => Hit | null} check
   */
  const spellingHit = (el, check) => {
    const s0 = el.replace(/\\/g, '/')
    const s = fold ? s0.toLowerCase() : s0
    for (const { v, kind } of spellings) {
      const needle = fold ? v.toLowerCase() : v
      let from = 0
      for (;;) {
        const i = s.indexOf(needle, from)
        if (i < 0) break
        from = i + 1
        let j = i + needle.length
        let k = j
        while (k < s.length && (s[k] === '.' || s[k] === ' ')) k++
        if (k > j && (k === s.length || s[k] === '/')) j = k
        if (j < s.length && s[j] !== '/' && !TERM.includes(s[j])) continue
        if (kind === 'unc') {
          if (/(?:^|[^/:])\/\/[^/\s]+(?:\/[^/\s]+)?$/.test(s.slice(Math.max(0, i - 300), i))) {
            return { root: v, form: el.slice(Math.max(0, i - 40), i + needle.length), reason: 'names a real home through a UNC share' }
          }
          continue
        }
        if (kind === 'msys' && i > 0 && !TERM.includes(s[i - 1])) continue
        let end = i + needle.length
        while (end < el.length && !TERM.includes(el[end])) end++
        const hit = check(el.slice(i, end))
        if (hit) return hit
      }
    }
    return null
  }

  const PATH_START = /^(?:[A-Za-z]:|[\\/]|\.|~)/
  const wordAt = new RegExp(`[^${TERM.replace(/[\]\\^-]/g, '\\$&')}]*`, 'y')

  /**
   * Every path written in an argument, checked: the argument itself when it is one
   * word, each value after any `=` that starts like a path, paths embedded anywhere,
   * and real-root spellings. Linear in the argument; the first FULL_CHECKS_PER_ARG
   * distinct candidates get the full realpath walk, the rest are resolved through their
   * (memoised) folder.
   * @param {string} whole @param {string} base @returns {Hit | null}
   */
  const argHit = (whole, base) => {
    const el = blankExecWords(whole)
    /** @type {ScanCtx} */ const ctx = { memo: new Map(), full: 0 }
    const seen = new Set()
    const check = (/** @type {string} */ c) => {
      if (!c || seen.has(c)) return null
      seen.add(c)
      ctx.lexOnly = /** @type {number} */ (ctx.full) >= FULL_CHECKS_PER_ARG
      if (!ctx.lexOnly) ctx.full = /** @type {number} */ (ctx.full) + 1
      return argCandidate(c, base, ctx)
    }
    if (!/\s/.test(el) && (/[\\/]/.test(el) || PATH_START.test(el))) {
      const hit = check(el)
      if (hit) return hit
    }
    for (let at = el.indexOf('='); at >= 0; at = el.indexOf('=', at + 1)) {
      wordAt.lastIndex = at + 1
      const m = wordAt.exec(el)
      if (m && m[0] && PATH_START.test(m[0])) {
        const hit = check(m[0])
        if (hit) return hit
      }
    }
    for (const c of embeddedPaths(el)) {
      const hit = check(c)
      if (hit) return hit
    }
    return spellingHit(el, check)
  }

  /**
   * The command word of a shell line (`cmd /c <line>`, `sh -c <line>`) and where it
   * sits in the line: a quoted word ends at its closing quote (cmd's `""<path>" args"`
   * included), an unquoted one at whitespace or shell punctuation (; & | < > ( )).
   * @param {string} line @returns {{ word: string, start: number, end: number }}
   */
  const commandWord = (line) => {
    const lead = /^\s*/.exec(line)?.[0].length ?? 0
    const q = /^(["'])\1*/.exec(line.slice(lead))
    if (q) {
      const start = lead + q[0].length
      const close = line.indexOf(q[1], start)
      const end = close < 0 ? line.length : close
      return { word: line.slice(start, end), start, end }
    }
    const m = /^[^\s;&|<>()]*/.exec(line.slice(lead))
    const end = lead + (m ? m[0].length : 0)
    return { word: line.slice(lead, end), start: lead, end }
  }

  /**
   * A shell line with its command word blanked out when that word is a program in a
   * real home's npm or nvm folder (an npm shim) or the running node binary (exact
   * spelling); otherwise the line unchanged. Only that position is exempt: the same path
   * anywhere else in the line is still checked.
   * @param {string} line @param {string} base
   */
  const stripCommandWord = (line, base) => {
    const { word, start, end } = commandWord(line)
    if (!word || !(inInstallRoot(word, base) || isExecWord(word))) return line
    return line.slice(0, start) + ' '.repeat(end - start) + line.slice(end)
  }

  /**
   * A `cd` / `chdir` / `pushd` (cmd, POSIX shells; also glued: `cd/d`, `cd\`, `cd..`)
   * or `Set-Location` / `sl` / `Push-Location` (PowerShell) in a shell line into a real
   * home, or into a folder above one, a filesystem root that holds one included (the
   * relative paths after it would then reach it).
   * @param {string} line @param {string} base @returns {Hit | null}
   */
  const cdHit = (line, base) => {
    const words = shellWords(line)
    for (let i = 0; i < words.length; i++) {
      const m = /^(cd|chdir|pushd|set-location|sl|push-location)([\\/.].*)?$/i.exec(words[i])
      if (!m) continue
      /** @type {string[]} */ const rest = m[2] ? [m[2], ...words.slice(i + 1)] : words.slice(i + 1)
      let j = 0
      while (j < rest.length && /^(?:\/[a-z]|-[a-z-]+)$/i.test(rest[j])) j++
      const target = rest[j]
      if (!target) continue
      const ctx = { memo: new Map() }
      for (const f of [target, ...msysForms(target)]) {
        const hit = classify(f, base, ctx)
        if (hit && (f === target || !hit.device)) return { ...hit, reason: 'is a cd into a real home' }
        if (coversReal(f, base, ctx, true)) return { root: f, form: target, reason: 'is a cd into a folder above a real home' }
      }
    }
    return null
  }

  /** Links inside an existing folder tree that lead into a real home. @returns {Hit | null} */
  const treeHit = (/** @type {unknown} */ dir) => {
    const readdir = fsImpl.readdirSync
    if (!readdir) return null
    const start = pathStrings(dir, platform)[0]
    if (start === undefined) return null
    /** @type {string[]} */ const queue = [P.resolve(cwd(), start)]
    let seen = 0
    while (queue.length > 0) {
      const cur = /** @type {string} */ (queue.pop())
      let st
      try {
        st = fsImpl.lstatSync(cur, { throwIfNoEntry: false })
      } catch {
        st = undefined
      }
      if (!st) continue
      if (++seen > TREE_LIMIT) return { root: start, form: start, reason: `is a folder tree over ${TREE_LIMIT} entries the guard cannot check for links` }
      if (st.isSymbolicLink()) {
        const hit = classify(cur)
        if (hit) return { ...hit, reason: 'holds a link into a real home' }
        continue
      }
      if (!st.isDirectory()) continue
      let names = []
      try {
        names = readdir(cur)
      } catch {
        names = []
      }
      for (const n of names) queue.push(P.join(cur, String(n)))
    }
    return null
  }

  return {
    platform,
    /** @param {unknown} input @param {string} [base] */
    classify: (input, base) => classify(input, base),
    /** @param {unknown} input @param {string} [base] */
    classifyEntry: (input, base) => classifyEntry(input, base),
    argHit,
    treeHit,
    commandWord,
    stripCommandWord,
    cdHit,
    /** @param {unknown} p */
    isProtected: (p) => classify(p) !== null,
    /** @param {string} p @param {string} [base] */
    inInstallRoot: (p, base) => inInstallRoot(p, base ?? cwd()),
    /** @param {string} s @param {string} [base] */
    keysOf: (s, base) => formsOf(s, base ?? cwd()).forms.map((f) => keyOf(f, platform)),
  }
}

// ---------------------------------------------------------------------------
// Capture and state.

/**
 * The value Node gives a child for `name`: keys in for...in order (prototype
 * values included), and on Windows the first case-variant in sorted order wins.
 * @param {Record<string, unknown>} env @param {string} name @param {boolean} [win]
 */
function envValue(env, name, win = IS_WIN) {
  /** @type {string[]} */ const keys = []
  for (const k in env) keys.push(k)
  const match = win ? keys.filter((k) => k.toUpperCase() === name.toUpperCase()).sort() : keys.filter((k) => k === name)
  for (const k of match) {
    const v = env[k]
    if (v !== undefined) return `${v}`
  }
  return undefined
}

/** @param {Record<string, unknown>} env */
function envHomeDrivePath(env) {
  const d = envValue(env, 'HOMEDRIVE')
  const p = envValue(env, 'HOMEPATH')
  return d && p ? d + p : undefined
}

function osUserHome() {
  try {
    return os.userInfo().homedir
  } catch {
    return undefined
  }
}

function osUserName() {
  try {
    return os.userInfo().username
  } catch {
    return undefined
  }
}

function osHome() {
  try {
    return os.homedir()
  } catch {
    return undefined
  }
}

/** @param {string | undefined} raw */
function parseMarker(raw) {
  if (!nonEmpty(raw)) return null
  try {
    const m = JSON.parse(raw)
    if (!m || m.v !== 1) return null
    const list = (/** @type {unknown} */ x) => (Array.isArray(x) ? x.filter(nonEmpty) : [])
    return { real: list(m.real), tmp: list(m.tmp), inst: list(m.inst), runner: list(m.runner), isolated: nonEmpty(m.isolated) ? m.isolated : undefined }
  } catch {
    return null
  }
}

/** The home variables pointed at `root` (the home is `<root>/home`). @param {string} root @param {string} [platform] */
export function isolatedHomeVars(root, platform = process.platform) {
  return homeVarsAt(pathApi(platform).join(root, 'home'), platform)
}

/** The home variables for the home folder `home` itself. @param {string} home @param {string} [platform] */
export function homeVarsAt(home, platform = process.platform) {
  const P = pathApi(platform)
  /** @type {Record<string, string>} */
  const vars = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: P.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: P.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: P.join(home, '.claude'),
    CODEX_HOME: P.join(home, '.codex'),
  }
  if (platform === 'win32') {
    const m = /^([a-z]:)(\\.*)$/i.exec(home)
    if (m) {
      vars.HOMEDRIVE = m[1]
      vars.HOMEPATH = m[2]
    }
  } else {
    vars.XDG_CONFIG_HOME = P.join(home, '.config')
    vars.XDG_DATA_HOME = P.join(home, '.local', 'share')
    vars.XDG_STATE_HOME = P.join(home, '.local', 'state')
    vars.XDG_CACHE_HOME = P.join(home, '.cache')
  }
  return vars
}

/** A real home's program-install folders: npm's global prefix and nvm. @param {Record<string, string | undefined>} env */
function installRootsFrom(env) {
  /** @type {(string | undefined)[]} */ const out = [env.NVM_HOME, env.NVM_SYMLINK, env.NVM_DIR, env.npm_config_prefix]
  if (IS_WIN) {
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm'), path.join(env.APPDATA, 'nvm'))
  } else {
    if (env.HOME) out.push(path.join(env.HOME, '.nvm'), path.join(env.HOME, '.npm-global'))
    out.push(path.dirname(path.dirname(process.execPath)))
  }
  return [...new Set(out.filter(nonEmpty).map((p) => path.resolve(p)))]
}

/**
 * The runner temp folders that count as temp areas: GitHub Actions' layout only, where
 * RUNNER_TEMP is `<work>/_temp` and `<work>` holds the checkout (`<work>/<repo>/<repo>`
 * on every runner). A value must be absolute, named exactly `_temp`, sit in a folder
 * that holds the project root, and hold none of `homes`.
 * @param {string[]} candidates
 * @param {{ projectRoot: string, homes: string[], platform?: string, fsImpl?: FsImpl }} opts
 * @returns {string[]}
 */
export function runnerTempsFrom(candidates, opts) {
  const platform = opts.platform ?? process.platform
  const P = pathApi(platform)
  const checkerFor = (/** @type {string} */ root) => createHomeChecker({ realRoots: [root], platform, fsImpl: opts.fsImpl, cwd: () => P.parse(root).root })
  /** @type {string[]} */ const out = []
  for (const c of candidates) {
    if (!nonEmpty(c) || !P.isAbsolute(c)) continue
    const t = P.resolve(c)
    const name = P.basename(t)
    if ((foldsCase(platform) ? name.toLowerCase() : name) !== '_temp') continue
    if (!checkerFor(P.dirname(t)).isProtected(opts.projectRoot)) continue
    const holds = checkerFor(t)
    if (opts.homes.some((h) => nonEmpty(h) && holds.isProtected(h))) continue
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/**
 * Real roots, temp roots, install roots and the isolated root for this process.
 * Order matters: trusted real roots (the OS profile, a parent's real roots) are
 * fixed first; a temp root that contains one is refused; an environment home inside
 * an accepted temp root or the isolated root is a temporary home, not a real one.
 * @param {{ extraTmpRoots?: string[], isolated?: string, markerRaw?: string }} [opts]
 */
function buildConfig(opts = {}) {
  const platform = process.platform
  const env = /** @type {Record<string, unknown>} */ (process.env)
  const markerRaw = opts.markerRaw ?? envValue(env, MARKER_ENV)
  const marker = parseMarker(markerRaw)
  const abs = (/** @type {string[]} */ list) => [...new Set(list.filter(nonEmpty).map((p) => path.resolve(p)))]

  const trustedReal = abs([osUserHome() ?? '', ...(marker ? marker.real : [])])
  for (const d of deriveAccountProfilesRoots(trustedReal, platform)) if (!trustedReal.includes(d)) trustedReal.push(d)
  const containsTrusted = (/** @type {string} */ t) => trustedReal.some((r) => createHomeChecker({ realRoots: [t], platform }).isProtected(r))
  // This process's own temp folder is trusted (a guarded parent checked TEMP/TMP/TMPDIR
  // in its environment). A temp root handed over in the marker counts only if it holds
  // this process's own temp folder, is named like a temp folder (Temp, tmp, T, _temp,
  // or this guard's ccc-vitest-*), and holds no trusted real home: a marker cannot turn
  // a home, or a folder in one, into an allowed area.
  const ownTmp = os.tmpdir()
  const tempNamed = (/** @type {string} */ t) => /^(?:_?te?mp|t|ccc-vitest-.+)$/i.test(path.basename(t))
  const holdsOwnTmp = (/** @type {string} */ t) => createHomeChecker({ realRoots: [t], platform }).isProtected(ownTmp)
  // The homes only this process's environment names (a profile USERPROFILE, a CLI's
  // config folder, ...).
  const envHomes = abs([...[...HOME_VARS, ...XDG_VARS, ...CONFIG_HOME_VARS].map((n) => envValue(env, n) ?? ''), envHomeDrivePath(env) ?? '', osHome() ?? ''])
  // A CI runner's per-job temp folder (GitHub Actions' RUNNER_TEMP, under HOME on its
  // Linux and macOS runners) is a temp area too, in the runner layout only (see
  // runnerTempsFrom). It comes from this process's RUNNER_TEMP or from the marker (a
  // child whose environment was rebuilt from an allowlist no longer has the variable),
  // under the same rule either way. A home the environment names inside it stays a real
  // home: the more specific root wins (as a CI step's own CODEX_HOME under RUNNER_TEMP).
  const runnerTemps = runnerTempsFrom([envValue(env, 'RUNNER_TEMP') ?? '', ...(marker ? marker.runner : [])], {
    projectRoot: PROJECT_ROOT,
    homes: trustedReal,
    platform,
  })
  const ownTmpRoots = abs([
    ...abs([...(opts.extraTmpRoots ?? []), ownTmp]),
    ...abs(marker ? marker.tmp : []).filter((t) => tempNamed(t) && holdsOwnTmp(t)),
  ]).filter((t) => !containsTrusted(t))
  const tmpRoots = abs([...ownTmpRoots, ...runnerTemps])

  /** @type {Record<string, string | undefined>} */
  const originalEnv = {}
  for (const name of [...HOME_VARS, ...XDG_VARS, ...CONFIG_HOME_VARS, 'HOMEDRIVE', 'HOMEPATH', 'NVM_HOME', 'NVM_SYMLINK', 'NVM_DIR', 'npm_config_prefix', 'RUNNER_TEMP']) {
    originalEnv[name] = envValue(env, name)
  }
  // A home inside this process's own temp area is a temporary home; one inside a runner
  // temp folder is not (see above).
  const inTmp = createHomeChecker({ realRoots: ownTmpRoots, platform })
  let captured = envHomes.filter((v) => !inTmp.isProtected(v))

  const base = [...tmpRoots.map((p) => /** @type {AllowedRoot} */ ({ path: p, kind: 'tmp' })), { path: PROJECT_ROOT, kind: /** @type {'project'} */ ('project') }]
  let isolated = opts.isolated ?? marker?.isolated
  if (isolated) {
    const probe = createHomeChecker({ realRoots: [...trustedReal, ...captured], allowedRoots: base, platform })
    if (probe.isProtected(isolated) || containsTrusted(isolated)) isolated = undefined
  }
  if (isolated) {
    const inIso = createHomeChecker({ realRoots: [isolated], platform })
    captured = captured.filter((v) => !inIso.isProtected(v))
  }
  const realRaw = abs([...trustedReal, ...captured])
  for (const d of deriveAccountProfilesRoots(realRaw, platform)) if (!realRaw.includes(d)) realRaw.push(d)
  // This process works out its own install folders. One handed over in a marker counts
  // only if it is an npm or nvm folder by name (npm, nvm, .nvm, .npm-global, nodejs)
  // and holds no real home: a marker cannot make a home, or a folder in it, exempt.
  const holdsReal = (/** @type {string} */ t) => realRaw.some((r) => createHomeChecker({ realRoots: [t], platform }).isProtected(r))
  const npmNamed = (/** @type {string} */ t) => /^(?:npm|nvm|\.nvm|\.npm-global|nodejs)$/i.test(path.basename(t))
  const installRoots = abs([
    ...abs(marker ? marker.inst : []).filter((t) => npmNamed(t) && !holdsReal(t)),
    ...installRootsFrom(originalEnv).filter((t) => !holdsReal(t)),
  ])
  const userNames = [osUserName() ?? '', ...realRaw.map((r) => path.basename(r))]
  const allowedRoots = isolated ? [{ path: isolated, kind: /** @type {'isolated'} */ ('isolated') }, ...base] : base
  const checker = createHomeChecker({ realRoots: realRaw, allowedRoots, installRoots, userNames, executables: [process.execPath], platform })
  return { platform, realRaw, tmpRoots, runnerTemps, installRoots, isolated, checker, originalEnv, markerRaw }
}

/**
 * @typedef {ReturnType<typeof buildConfig> & {
 *   entry: string, isolatedEnv: Record<string, string> | null, ptyGuarded?: boolean,
 *   safeArea?: ReturnType<typeof createHomeChecker>, protectedFds: Map<number, string>,
 *   spawnDepth: number, fhProtoGuarded?: boolean,
 *   violations: { op: string, target: string, root: string }[] }} GuardState
 */

/** @returns {GuardState | undefined} */
function getState() {
  return /** @type {any} */ (process)[STATE_KEY]
}

/** @param {{ realRaw: string[], tmpRoots: string[], runnerTemps: string[], installRoots: string[] }} c @param {string | undefined} isolated */
function markerValue(c, isolated) {
  return JSON.stringify({ v: 1, real: c.realRaw, tmp: c.tmpRoots, runner: c.runnerTemps, inst: c.installRoots, isolated })
}

/** @param {GuardState} state @param {string} op @param {unknown} target @param {Hit} hit */
function violation(state, op, target, hit) {
  // A Buffer or URL argument is shown as the path it names (Node's recursive rm passes Buffers).
  const shown = typeof target === 'string' ? target : (pathStrings(target, process.platform)[0] ?? hit.form)
  const err = new TestIsolationViolation(op, shown, hit.root, hit.reason)
  state.violations.push({ op, target: shown, root: hit.root })
  if (state.entry === 'probe') {
    try {
      process.stderr.write(err.message + '\n')
    } catch {
      /* stderr closed */
    }
  }
  return err
}

// ---------------------------------------------------------------------------
// fs guard.

/**
 * Which arguments name a target: indexes, or a rule.
 * @typedef {number[] | 'open' | 'symlink' | 'read' | 'stream' | 'cp' | 'fd'} Spec
 */
/** @type {[string, Spec][]} */
const FS_SYNC_AND_CALLBACK = [
  ['rm', [0]], ['rmSync', [0]], ['rmdir', [0]], ['rmdirSync', [0]], ['unlink', [0]], ['unlinkSync', [0]],
  ['rename', [0, 1]], ['renameSync', [0, 1]],
  ['writeFile', [0]], ['writeFileSync', [0]], ['appendFile', [0]], ['appendFileSync', [0]],
  ['mkdir', [0]], ['mkdirSync', [0]], ['mkdtemp', [0]], ['mkdtempSync', [0]], ['mkdtempDisposableSync', [0]],
  ['copyFile', [1]], ['copyFileSync', [1]], ['cp', 'cp'], ['cpSync', 'cp'],
  ['symlink', 'symlink'], ['symlinkSync', 'symlink'], ['link', [0, 1]], ['linkSync', [0, 1]],
  ['truncate', [0]], ['truncateSync', [0]], ['chmod', [0]], ['chmodSync', [0]], ['lchmod', [0]], ['lchmodSync', [0]],
  ['chown', [0]], ['chownSync', [0]], ['lchown', [0]], ['lchownSync', [0]],
  ['utimes', [0]], ['utimesSync', [0]], ['lutimes', [0]], ['lutimesSync', [0]],
  ['open', 'open'], ['openSync', 'open'], ['createWriteStream', [0]],
  ['readFile', 'read'], ['readFileSync', 'read'], ['createReadStream', 'stream'],
  ['fchmod', 'fd'], ['fchmodSync', 'fd'], ['fchown', 'fd'], ['fchownSync', 'fd'],
  ['futimes', 'fd'], ['futimesSync', 'fd'], ['ftruncate', 'fd'], ['ftruncateSync', 'fd'],
]
/** @type {[string, Spec][]} */
const FS_PROMISES = [
  ['rm', [0]], ['rmdir', [0]], ['unlink', [0]], ['rename', [0, 1]],
  ['writeFile', [0]], ['appendFile', [0]], ['mkdir', [0]], ['mkdtemp', [0]], ['mkdtempDisposable', [0]],
  ['copyFile', [1]], ['cp', 'cp'], ['symlink', 'symlink'], ['link', [0, 1]],
  ['truncate', [0]], ['chmod', [0]], ['lchmod', [0]], ['chown', [0]], ['lchown', [0]],
  ['utimes', [0]], ['lutimes', [0]], ['open', 'open'], ['readFile', 'read'],
]
// Operations on a folder entry itself (a link is removed, moved or touched, not followed).
const ENTRY_OPS = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync', 'lutimes', 'lutimesSync'])
const FILEHANDLE_MUTATORS = ['chmod', 'chown', 'utimes', 'truncate', 'write', 'writev', 'writeFile', 'appendFile', 'createWriteStream']

const SAFE_READ_BITS = ['O_RDONLY', 'O_NOFOLLOW', 'O_DIRECTORY', 'O_NOATIME', 'O_NONBLOCK', 'O_SYNC', 'O_DSYNC', 'O_NOCTTY', 'UV_FS_O_FILEMAP'].reduce(
  (acc, n) => acc | (/** @type {Record<string, number>} */ (fs.constants)[n] ?? 0),
  0,
)

/** Read-only flags only (an allow-list): anything else is treated as a write. @param {unknown} flags */
export function isReadOnlyFlag(flags) {
  if (flags === undefined || flags === null) return true
  if (typeof flags === 'string') return flags === 'r' || flags === 'rs' || flags === 'sr'
  if (typeof flags === 'number') return Number.isInteger(flags) && (flags & ~SAFE_READ_BITS) === 0
  return false
}

/** The flag in a readFile / createReadStream options argument. @param {unknown} o @param {'flag' | 'flags'} key */
function optionFlag(o, key) {
  return o && typeof o === 'object' ? /** @type {any} */ (o)[key] : undefined
}

/** @param {GuardState} state @param {string} op @param {Spec} spec @param {unknown[]} args @returns {string | undefined} a protected path opened read-only */
function checkFsCall(state, op, spec, args) {
  const check = (/** @type {unknown} */ target, /** @type {string} */ what, /** @type {string | undefined} */ base = undefined) => {
    const hit = state.checker.classify(target, base)
    if (hit) throw violation(state, what, target, hit)
  }
  switch (spec) {
    case 'open': {
      if (!isReadOnlyFlag(args[1])) check(args[0], op)
      else if (state.checker.isProtected(args[0])) return pathStrings(args[0], state.platform)[0] ?? String(args[0])
      return undefined
    }
    case 'read':
      if (typeof args[0] !== 'number' && !isReadOnlyFlag(optionFlag(args[1], 'flag'))) check(args[0], op)
      return undefined
    case 'stream':
      if (!isReadOnlyFlag(optionFlag(args[1], 'flags'))) check(args[0], op)
      return undefined
    case 'fd': {
      const opened = typeof args[0] === 'number' ? state.protectedFds.get(args[0]) : undefined
      if (opened !== undefined) throw violation(state, op, `fd ${args[0]} (${opened})`, { root: opened, form: opened, reason: 'is a real-home file opened read-only' })
      return undefined
    }
    case 'symlink': {
      check(args[1], op)
      // A link into a real home is the first step of every escape: refuse to make one.
      const linkPath = pathStrings(args[1], state.platform)[0]
      if (linkPath !== undefined) check(args[0], op + ' target', path.dirname(path.resolve(linkPath)))
      return undefined
    }
    case 'cp': {
      check(args[1], op)
      const o = args[2]
      if (o && typeof o === 'object' && /** @type {any} */ (o).recursive) {
        const hit = state.checker.treeHit(args[1])
        if (hit) throw violation(state, op, args[1], hit)
      }
      return undefined
    }
    default: {
      // An operation on the folder entry itself does not follow a link in the last component.
      const entry = ENTRY_OPS.has(op.slice(op.lastIndexOf('.') + 1))
      for (const i of spec) {
        if (!entry) check(args[i], op)
        else {
          const hit = state.checker.classifyEntry(args[i])
          if (hit) throw violation(state, op, args[i], hit)
        }
      }
      return undefined
    }
  }
}

/** Remember an fd opened read-only on a real-home path, until it is closed. @param {GuardState} state @param {unknown} fd @param {string} p */
function trackFd(state, fd, p) {
  if (typeof fd === 'number') state.protectedFds.set(fd, p)
}

/**
 * The FileHandle prototype's mutating methods refuse a handle whose fd was opened
 * read-only on a real-home path (patched once, on the first FileHandle seen, so a
 * call through the prototype is checked too).
 * @param {GuardState} state @param {any} fh
 */
function guardFileHandleProto(state, fh) {
  if (state.fhProtoGuarded || !fh || typeof fh !== 'object') return
  const proto = Object.getPrototypeOf(fh)
  if (!proto) return
  state.fhProtoGuarded = true
  for (const name of FILEHANDLE_MUTATORS) {
    const orig = proto[name]
    if (typeof orig !== 'function') continue
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (/** @type {unknown[]} */ ...a) {
        // @ts-ignore -- the FileHandle receiver
        const fd = this && typeof this.fd === 'number' ? this.fd : undefined
        const opened = fd === undefined ? undefined : state.protectedFds.get(fd)
        if (opened !== undefined) {
          const err = violation(state, 'FileHandle.' + name, `fd ${fd} (${opened})`, { root: opened, form: opened, reason: 'is a real-home file opened read-only' })
          if (name === 'createWriteStream') throw err
          return Promise.reject(err)
        }
        // @ts-ignore -- forwarding the caller's receiver
        return orig.apply(this, a)
      },
    })
  }
}

/** Track a FileHandle opened read-only on a real-home path until it is closed. @param {GuardState} state @param {any} fh @param {string} p */
function guardFileHandle(state, fh, p) {
  if (!fh || typeof fh !== 'object') return
  const fd = fh.fd
  trackFd(state, fd, p)
  const close = fh.close
  if (typeof close === 'function') {
    Object.defineProperty(fh, 'close', {
      configurable: true,
      value: function (/** @type {unknown[]} */ ...a) {
        state.protectedFds.delete(fd)
        return close.apply(fh, a)
      },
    })
  }
}

/** @param {GuardState} state @param {any} target @param {string} prefix @param {[string, Spec][]} table @param {boolean} promise */
function wrapFsTable(state, target, prefix, table, promise) {
  for (const [name, spec] of table) {
    const orig = target[name]
    if (typeof orig !== 'function') continue
    const op = prefix + name
    /** @type {Function} */ let guarded
    if (promise) {
      guarded = function (/** @type {unknown[]} */ ...args) {
        let opened
        try {
          opened = checkFsCall(state, op, spec, args)
        } catch (e) {
          return Promise.reject(e)
        }
        // @ts-ignore -- forwarding the caller's receiver
        const out = orig.apply(this, args)
        if (spec === 'open' && out && typeof out.then === 'function') {
          return out.then((/** @type {any} */ fh) => {
            guardFileHandleProto(state, fh)
            if (opened !== undefined) guardFileHandle(state, fh, opened)
            return fh
          })
        }
        return out
      }
    } else if (spec === 'open' && name === 'open') {
      guarded = function (/** @type {unknown[]} */ ...args) {
        const opened = checkFsCall(state, op, spec, args)
        const cb = args[args.length - 1]
        if (opened !== undefined && typeof cb === 'function') {
          args[args.length - 1] = (/** @type {unknown} */ err, /** @type {unknown} */ fd) => {
            if (!err) trackFd(state, fd, opened)
            return cb(err, fd)
          }
        }
        // @ts-ignore -- forwarding the caller's receiver
        return orig.apply(this, args)
      }
    } else if (spec === 'open') {
      guarded = function (/** @type {unknown[]} */ ...args) {
        const opened = checkFsCall(state, op, spec, args)
        // @ts-ignore -- forwarding the caller's receiver
        const fd = orig.apply(this, args)
        if (opened !== undefined) trackFd(state, fd, opened)
        return fd
      }
    } else {
      guarded = function (/** @type {unknown[]} */ ...args) {
        checkFsCall(state, op, spec, args)
        // @ts-ignore -- forwarding the caller's receiver
        return orig.apply(this, args)
      }
    }
    Object.defineProperty(guarded, 'name', { value: name })
    target[name] = guarded
  }
  if (!promise) {
    for (const name of ['close', 'closeSync']) {
      const orig = target[name]
      if (typeof orig !== 'function') continue
      const guarded = function (/** @type {unknown[]} */ ...args) {
        if (typeof args[0] === 'number') state.protectedFds.delete(args[0])
        // @ts-ignore -- forwarding the caller's receiver
        return orig.apply(this, args)
      }
      Object.defineProperty(guarded, 'name', { value: name })
      target[name] = guarded
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn guard.

/** Quote-aware split of a command line into words. @param {string} s */
function shellWords(s) {
  /** @type {string[]} */ const out = []
  let cur = ''
  let quote = ''
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (/[\s;&|<>()]/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** @param {unknown} exe */
function isNodeExecutable(exe) {
  if (typeof exe !== 'string' || !exe) return false
  if (path.resolve(exe) === path.resolve(process.execPath)) return true
  return /^(?:node|nodejs)(?:\.exe)?$/i.test(path.basename(exe))
}

const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title', '--stack-size', '--max-old-space-size'])

/** Index (in `args`) of the script node is asked to run, or -1. @param {string[]} args */
function nodeScriptIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return i + 1 < args.length ? i + 1 : -1
    if (/^(?:-e|-p|--eval|--print|-pe|-ep)$/.test(a) || /^--(?:eval|print)=/.test(a)) return -1
    if (NODE_VALUE_OPTIONS.has(a)) {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return i
  }
  return -1
}

/**
 * The child environment exactly as Node and libuv will build it, with the isolated
 * home filled in where it is missing, the guard preload and the guard marker added,
 * then checked. Returns the env object to pass.
 * @param {GuardState} state @param {string} op @param {Record<string, unknown>} src @param {string} cwdAbs
 */
function childEnv(state, op, src, cwdAbs) {
  /** @type {string[]} */ let keys = []
  for (const k in src) keys.push(k)
  if (IS_WIN) {
    const seen = new Set()
    keys = keys.sort().filter((k) => {
      const u = k.toUpperCase()
      if (seen.has(u)) return false
      seen.add(u)
      return true
    })
  }
  /** @type {Record<string, string>} */ const out = {}
  for (const k of keys) {
    const v = src[k]
    if (v !== undefined) out[k] = `${v}`
  }
  const keyFor = (/** @type {string} */ name) => (IS_WIN ? Object.keys(out).find((k) => k.toUpperCase() === name.toUpperCase()) : name in out ? name : undefined)
  const get = (/** @type {string} */ name) => {
    const k = keyFor(name)
    return k === undefined ? undefined : out[k]
  }
  const set = (/** @type {string} */ name, /** @type {string} */ value) => {
    out[keyFor(name) ?? name] = value
  }
  // A caller that hands the child its own home gets the other folders under that home;
  // otherwise they come from the isolated home. (The given home is checked below.)
  const homeName = IS_WIN ? (get('USERPROFILE') !== undefined ? 'USERPROFILE' : 'HOME') : get('HOME') !== undefined ? 'HOME' : 'USERPROFILE'
  const givenHome = get(homeName)
  if (givenHome) {
    const hit = state.checker.classify(givenHome, cwdAbs)
    if (hit) throw violation(state, `${op} env ${homeName}`, givenHome, hit)
  }
  const fillFrom = givenHome ? homeVarsAt(path.resolve(cwdAbs, givenHome)) : state.isolatedEnv
  for (const name of FILL_VARS) {
    const value = fillFrom && fillFrom[name]
    if (get(name) === undefined && value) set(name, value)
  }
  // The temp folder carries over too (POSIX does not copy it in; a child that fell back
  // to /tmp would take the temp home it was given for a real one). On Windows libuv
  // copies TEMP in itself; that live value is checked below.
  for (const name of TEMP_VARS) {
    if (LIBUV_REQUIRED.includes(name)) continue
    const value = envValue(/** @type {any} */ (process.env), name)
    if (get(name) === undefined && value) set(name, value)
  }
  // What libuv will add on Windows, from the live process environment.
  const live = (/** @type {string} */ name) => get(name) ?? (LIBUV_REQUIRED.includes(name) ? envValue(/** @type {any} */ (process.env), name) : undefined)
  for (const name of [...HOME_VARS, ...XDG_VARS, ...TEMP_VARS]) {
    const v = live(name)
    if (v === undefined || v === '') continue
    const hit = state.checker.classify(v, cwdAbs)
    if (hit) throw violation(state, `${op} env ${name}`, v, hit)
  }
  // A RUNNER_TEMP other than this process's own (one a caller set) is checked like TEMP:
  // the child would take it for a temp area. The runner's own value passes through; the
  // child applies the runner layout rule to it itself.
  const runnerTemp = get('RUNNER_TEMP')
  if (runnerTemp && runnerTemp !== state.originalEnv.RUNNER_TEMP) {
    const hit = state.checker.classify(runnerTemp, cwdAbs)
    if (hit) throw violation(state, `${op} env RUNNER_TEMP`, runnerTemp, hit)
  }
  // Variables that point git or npm at a config, cache or prefix folder.
  for (const k of Object.keys(out)) {
    if (!CONFIG_REDIRECT.test(k)) continue
    const v = out[k]
    if (!v) continue
    const hit = state.checker.classify(v, cwdAbs)
    if (hit) throw violation(state, `${op} env ${k}`, v, hit)
  }
  const drive = live('HOMEDRIVE')
  const hpath = live('HOMEPATH')
  if (hpath) {
    const v = (drive ?? '') + hpath
    const hit = state.checker.classify(v, cwdAbs)
    if (hit) throw violation(state, `${op} env HOMEDRIVE+HOMEPATH`, v, hit)
  }
  for (const name of FALLBACK_VARS) {
    if (live(name) === undefined) {
      throw violation(state, `${op} env ${name}`, `(unset ${name})`, { root: '(OS profile fallback)', form: name, reason: 'is unset and no isolated home is available' })
    }
  }
  const nodeOptions = get('NODE_OPTIONS') ?? ''
  if (!nodeOptions.includes(NODE_OPTIONS_IMPORT)) set('NODE_OPTIONS', (nodeOptions ? nodeOptions + ' ' : '') + NODE_OPTIONS_IMPORT)
  const given = parseMarker(get(MARKER_ENV))
  set(
    MARKER_ENV,
    JSON.stringify({
      v: 1,
      real: [...new Set([...(given ? given.real : []), ...state.realRaw])],
      tmp: given ? given.tmp : state.tmpRoots,
      runner: given ? given.runner : state.runnerTemps,
      inst: [...new Set([...(given ? given.inst : []), ...state.installRoots])],
      isolated: given ? given.isolated : state.isolated,
    }),
  )
  return out
}

/**
 * @param {GuardState} state @param {string} op
 * @param {{ exe: unknown, args: unknown[], options: any, line?: string, script?: number }} call
 *   `line`: a shell command line (its first word is the executable); `script`: the
 *   index in `args` of the script node runs (-1: none)
 * @returns {any} the options to use (a copy carrying the checked child environment)
 */
function checkSpawn(state, op, call) {
  const options = call.options && typeof call.options === 'object' ? call.options : undefined
  const cwdInput = options && options.cwd != null ? options.cwd : process.cwd()
  const cwdHit = state.checker.classify(cwdInput)
  if (cwdHit) throw violation(state, op + ' cwd', cwdInput, cwdHit)
  const cwdAbs = path.resolve(pathStrings(cwdInput, state.platform)[0] ?? process.cwd())

  /** @type {string[]} */ let elements
  let script = call.script ?? -1
  /** @type {string[]} */ const shellLines = []
  if (call.line !== undefined) {
    const words = shellWords(call.line)
    elements = words.slice(1)
    script = isNodeExecutable(words[0]) ? nodeScriptIndex(elements) : -1
    shellLines.push(call.line)
  } else {
    elements = call.args.map((a) => String(a))
    if (call.script === undefined) script = isNodeExecutable(call.exe) ? nodeScriptIndex(elements) : -1
    // A command line handed to cmd.exe (`/c`, `/k`) or a POSIX shell (`-c`): its
    // command word may be a program in a real home's npm or nvm folder (an npm shim),
    // as narrowly as a node script: that word's own position is blanked before the
    // scan; the same path anywhere else in the line is still checked. A PowerShell
    // `-Command` line gets the cd rule only.
    const exeName = path.basename(String(call.exe ?? '')).toLowerCase()
    let from = -1
    if (/^cmd(?:\.exe)?$/.test(exeName)) from = elements.findIndex((a) => /^\/[ck]$/i.test(a)) + 1
    else if (/^(?:sh|bash|dash|zsh|ksh)(?:\.exe)?$/.test(exeName)) from = elements.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a)) + 1
    if (from > 0 && from < elements.length) {
      shellLines.push(/^cmd/.test(exeName) ? elements.slice(from).join(' ') : elements[from])
      elements = [...elements]
      elements[from] = state.checker.stripCommandWord(elements[from], cwdAbs)
    }
    if (/^(?:pwsh|powershell)(?:\.exe)?$/.test(exeName)) {
      const ci = elements.findIndex((a) => /^-(?:c|command)$/i.test(a))
      if (ci >= 0 && ci + 1 < elements.length) shellLines.push(elements.slice(ci + 1).join(' '))
    }
  }
  for (const line of shellLines) {
    const hit = state.checker.cdHit(line, cwdAbs)
    if (hit) throw violation(state, op + ' argv', line, hit)
  }
  const execArgv = options && Array.isArray(options.execArgv) ? options.execArgv.map((/** @type {unknown} */ a) => String(a)) : []
  const all = [...elements, ...execArgv]
  for (let i = 0; i < all.length; i++) {
    // The script node runs may live in a real home's npm or nvm folder; nothing else there.
    if (i === script && state.checker.inInstallRoot(all[i], cwdAbs)) continue
    const hit = state.checker.argHit(all[i], cwdAbs)
    if (hit) throw violation(state, op + ' argv', all[i], hit)
  }

  const src = options && options.env && typeof options.env === 'object' ? options.env : process.env
  return { ...(options ?? {}), env: childEnv(state, op, src, cwdAbs) }
}

/** @param {unknown} v */
function isOptionsObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** @param {GuardState} state @param {string} name @param {unknown[]} args */
function guardSpawnArgs(state, name, args) {
  const a = [...args]
  const exec = name === 'exec' || name === 'execSync'
  /** @type {unknown[]} */ let argv = []
  let optIdx = -1
  if (exec) optIdx = isOptionsObject(a[1]) ? 1 : -1
  else if (Array.isArray(a[1])) {
    argv = a[1]
    optIdx = isOptionsObject(a[2]) ? 2 : -1
  } else if (a[1] == null) optIdx = isOptionsObject(a[2]) ? 2 : -1
  else optIdx = isOptionsObject(a[1]) ? 1 : -1
  const options = optIdx >= 0 ? /** @type {any} */ (a[optIdx]) : undefined
  /** @type {{ exe: unknown, args: unknown[], options: any, line?: string, script?: number }} */
  let call
  if (exec) call = { exe: undefined, args: [], options, line: String(a[0]) }
  else if (name === 'fork') call = { exe: options?.execPath ?? process.execPath, args: [a[0], ...argv], options, script: 0 }
  else if (options && options.shell) call = { exe: undefined, args: [], options, line: [a[0], ...argv].map(String).join(' ') }
  else call = { exe: a[0], args: argv, options }
  const next = checkSpawn(state, 'child_process.' + name, call)
  if (optIdx >= 0) a[optIdx] = next
  else if (exec) a.splice(1, 0, next)
  else if (Array.isArray(a[1])) a.splice(2, 0, next)
  else if (a[1] == null && a.length >= 2) {
    a[1] = []
    a.splice(2, 0, next)
  } else a.splice(1, 0, [], next)
  return a
}

const SPAWN_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']

/** @param {GuardState} state */
function patchChildProcess(state) {
  const cp = /** @type {any} */ (childProcess)
  for (const name of SPAWN_FUNCTIONS) {
    const orig = cp[name]
    if (typeof orig !== 'function') continue
    const guarded = function (/** @type {unknown[]} */ ...args) {
      const checked = guardSpawnArgs(state, name, args)
      // The internal ChildProcess.prototype.spawn below this call is already checked.
      state.spawnDepth++
      try {
        // @ts-ignore -- forwarding the caller's receiver
        return orig.apply(this, checked)
      } finally {
        state.spawnDepth--
      }
    }
    Object.defineProperty(guarded, 'name', { value: name })
    // util.promisify(exec / execFile) uses this symbol; keep its result shape and
    // route it through the guard too.
    const custom = orig[util.promisify.custom]
    if (typeof custom === 'function') {
      Object.defineProperty(guarded, util.promisify.custom, {
        value: function (/** @type {unknown[]} */ ...args) {
          const checked = guardSpawnArgs(state, name, args)
          state.spawnDepth++
          try {
            // @ts-ignore -- forwarding the caller's receiver
            return custom.apply(this, checked)
          } finally {
            state.spawnDepth--
          }
        },
        configurable: true,
      })
    }
    cp[name] = guarded
  }

  // The async choke point every spawn goes through. A direct call (new ChildProcess()
  // .spawn({ file, args, cwd, envPairs })) skips the functions above: check it the same
  // way and hand it the checked environment.
  const proto = cp.ChildProcess && cp.ChildProcess.prototype
  const origProtoSpawn = proto && proto.spawn
  if (typeof origProtoSpawn === 'function') {
    proto.spawn = function spawn(/** @type {any} */ options) {
      if (state.spawnDepth > 0 || !options || typeof options !== 'object') return origProtoSpawn.call(this, options)
      /** @type {Record<string, string>} */ const env = {}
      for (const pair of Array.isArray(options.envPairs) ? options.envPairs : []) {
        const s = String(pair)
        const eq = s.indexOf('=', 1)
        if (eq > 0 && !(s.slice(0, eq) in env)) env[s.slice(0, eq)] = s.slice(eq + 1)
      }
      const args = Array.isArray(options.args) ? options.args.slice(1) : []
      const next = checkSpawn(state, 'ChildProcess.spawn', { exe: options.file, args, options: { cwd: options.cwd, env } })
      return origProtoSpawn.call(this, { ...options, envPairs: Object.entries(next.env).map(([k, v]) => `${k}=${v}`) })
    }
  }
}

/** process.execve replaces this process with one the guard never sees: refuse it. @param {GuardState} state */
function patchExecve(state) {
  const p = /** @type {any} */ (process)
  if (typeof p.execve !== 'function') return
  p.execve = function execve(/** @type {unknown} */ file) {
    throw violation(state, 'process.execve', String(file), { root: '(process image)', form: String(file), reason: 'would replace this process with an unguarded one' })
  }
}

/** node-pty, when it loads; a test that vi.mock()s it never reaches this object. @param {GuardState} state */
function patchNodePty(state) {
  /** @type {any} */ let pty
  try {
    pty = createRequire(path.join(PROJECT_ROOT, 'package.json'))('node-pty')
  } catch {
    return false
  }
  for (const name of ['spawn', 'fork', 'createTerminal']) {
    const orig = pty[name]
    if (typeof orig !== 'function') continue
    pty[name] = function (/** @type {unknown} */ file, /** @type {unknown} */ args, /** @type {unknown} */ opt) {
      const argv = Array.isArray(args) ? args : typeof args === 'string' ? [args] : []
      const next = checkSpawn(state, 'node-pty.' + name, { exe: file, args: argv, options: opt })
      // @ts-ignore -- forwarding the caller's receiver
      return orig.call(this, file, args, next)
    }
  }
  return true
}

// Node options that load code before a script: in a toolchain worker they would run ahead
// of the guard preamble.
const PRELOAD_FLAG = /^(?:-r|--require|--import|--loader|--experimental-loader)(?:=|$)/

/** execArgv without its preload options (and their values). @param {string[]} args */
function withoutPreloads(args) {
  /** @type {string[]} */ const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (PRELOAD_FLAG.test(a)) {
      if (!a.includes('=')) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** Workers get fresh, unpatched builtins: start a toolchain worker guarded, refuse the rest. @param {GuardState} state */
function patchWorkers(state) {
  const wt = /** @type {any} */ (workerThreads)
  const Orig = wt.Worker
  if (typeof Orig !== 'function') return
  // A toolchain worker (a script inside this project's own node_modules, such as
  // esbuild's sync service) starts GUARDED: a preamble loads probe-guard in the worker
  // before the script, and the worker gets the guard marker in its environment. Any
  // other Worker (eval code, a test's own script) is refused.
  const toolchain = createHomeChecker({ realRoots: [path.join(PROJECT_ROOT, 'node_modules')], platform: process.platform })
  const Guarded = function Worker(/** @type {unknown} */ filename, /** @type {any} */ options) {
    const o = options && typeof options === 'object' ? options : {}
    /** @type {string | undefined} */ let file
    if (!o.eval) {
      try {
        // A string is a path (Node takes no URL string); a URL object must be file: (a
        // data: URL throws here and is refused).
        file = filename instanceof URL ? fileURLToPath(filename) : typeof filename === 'string' ? path.resolve(filename) : undefined
      } catch {
        file = undefined
      }
    }
    if (file !== undefined && toolchain.isProtected(file)) {
      // A preload in the worker's execArgv would run before the guard preamble: refuse one
      // the caller names, and drop the ones a worker would inherit from this thread.
      /** @type {unknown[] | undefined} */ const given = Array.isArray(o.execArgv) ? o.execArgv : undefined
      if (given && given.some((a) => typeof a === 'string' && PRELOAD_FLAG.test(a))) {
        throw violation(state, 'worker_threads.Worker execArgv', given.join(' ').slice(0, 120), {
          root: '(worker thread)',
          form: 'execArgv',
          reason: 'would run a preload before the guard',
        })
      }
      const execArgv = given ?? withoutPreloads(process.execArgv)
      const src = o.env === undefined || o.env === wt.SHARE_ENV ? process.env : o.env
      const env = { ...src, [MARKER_ENV]: markerValue(state, state.isolated) }
      // The guard first, then the script (import() loads CommonJS and ES modules alike).
      // A failure is an unhandled rejection, which ends the worker with an error.
      const code = `import(${JSON.stringify(PROBE_GUARD_URL)}).then(() => import(${JSON.stringify(pathToFileURL(file).href)}))`
      return new Orig(code, { ...o, eval: true, env, execArgv })
    }
    throw violation(state, 'worker_threads.Worker', String(filename).slice(0, 120), {
      root: '(worker thread)',
      form: 'Worker',
      reason: 'would run with unguarded builtins (only a script in this project\'s node_modules starts, guarded)',
    })
  }
  Guarded.prototype = Orig.prototype
  // `new Worker.prototype.constructor(...)` would reach the original otherwise.
  Object.defineProperty(Orig.prototype, 'constructor', { value: Guarded, configurable: true, writable: true, enumerable: false })
  wt.Worker = Guarded
}

/** @param {GuardState} state */
function patchProcessBinding(state) {
  const p = /** @type {any} */ (process)
  const orig = p.binding
  if (typeof orig !== 'function') return
  p.binding = function binding(/** @type {string} */ name) {
    if (BINDINGS_REFUSED.includes(String(name))) {
      throw violation(state, 'process.binding', String(name), { root: '(internal binding)', form: String(name), reason: 'bypasses the guarded fs and child_process' })
    }
    return orig.call(process, name)
  }
}

// ---------------------------------------------------------------------------
// Install and the read-only API.

/** Drop the guard's own preload and marker from this process's view of its env. */
function hideGuardEnv() {
  const cur = process.env.NODE_OPTIONS
  if (cur !== undefined && cur.includes(NODE_OPTIONS_IMPORT)) {
    const rest = cur.split(NODE_OPTIONS_IMPORT).join(' ').replace(/\s+/g, ' ').trim()
    if (rest) process.env.NODE_OPTIONS = rest
    else delete process.env.NODE_OPTIONS
  }
  delete process.env[MARKER_ENV]
}

/** @param {GuardState} state */
function makeIsolated(state, /** @type {string[] | undefined} */ extraTmpRoots) {
  const origTmp = (extraTmpRoots ?? []).find(nonEmpty) ?? os.tmpdir()
  // A sibling of the per-worker temp root, never inside it: some code treats a home
  // below os.tmpdir() differently. The `ccc-vitest-` prefix lets global-setup sweep it.
  let root = fs.mkdtempSync(path.join(origTmp, 'ccc-vitest-home-'))
  // On Windows, the long form: a runner's TEMP carries 8.3 short names (RUNNER~1), which
  // a real profile path never has, and code that wants a plain path would read the
  // isolated home differently from a real one.
  if (IS_WIN) {
    try {
      root = fs.realpathSync.native(root)
    } catch {
      /* keep the path as made */
    }
  }
  // The marker this process started with is gone from its env by now; the state kept it.
  const { originalEnv: _orig, ...config } = buildConfig({ extraTmpRoots, isolated: root, markerRaw: state.markerRaw })
  Object.assign(state, config, { isolatedEnv: config.isolated ? isolatedHomeVars(config.isolated, config.platform) : null, safeArea: undefined })
  applyIsolatedEnv(state, true)
  process.once('exit', () => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* best effort; global-setup sweeps ccc-vitest-* */
    }
  })
}

/**
 * Isolate, then fail loudly if os.homedir() did not follow (a worker thread keeps its
 * own copy of the environment). @param {GuardState} state @param {string[] | undefined} extraTmpRoots
 */
function isolateNow(state, extraTmpRoots) {
  makeIsolated(state, extraTmpRoots)
  assertHomeIsolated()
}

/**
 * Install the guard once per process. `isolate` creates a fresh isolated root under
 * the original temp folder and points the home variables at it (the vitest entry);
 * it also upgrades a guard the probe entry installed earlier in this process
 * (a vitest worker started under a guarded parent). Without `isolate` the isolated
 * root is the one a guarded parent handed over.
 * @param {{ entry: 'vitest' | 'probe', isolate?: boolean, extraTmpRoots?: string[] }} opts
 * @returns {GuardState}
 */
export function installHomeGuard(opts) {
  const existing = getState()
  if (existing) {
    if (opts.isolate && existing.entry === 'probe') {
      existing.entry = opts.entry
      isolateNow(existing, opts.extraTmpRoots)
    }
    return existing
  }
  const config = buildConfig({ extraTmpRoots: opts.extraTmpRoots })
  hideGuardEnv()
  /** @type {GuardState} */
  const state = {
    ...config,
    entry: opts.entry,
    isolatedEnv: config.isolated ? isolatedHomeVars(config.isolated, config.platform) : null,
    protectedFds: new Map(),
    spawnDepth: 0,
    violations: [],
  }
  Object.defineProperty(process, STATE_KEY, { value: state, enumerable: false, configurable: false, writable: false })

  wrapFsTable(state, fs, 'fs.', FS_SYNC_AND_CALLBACK, false)
  wrapFsTable(state, fs.promises, 'fs.promises.', FS_PROMISES, true)
  patchChildProcess(state)
  state.ptyGuarded = patchNodePty(state)
  patchWorkers(state)
  patchProcessBinding(state)
  patchExecve(state)
  // `import { rmSync } from 'fs'`, `import * as fs from 'node:fs'`, fs/promises,
  // child_process and worker_threads named imports read the ESM bindings.
  syncBuiltinESMExports()

  if (opts.isolate) isolateNow(state, opts.extraTmpRoots)
  process.once('exit', () => {
    if (state.entry !== 'probe') return
    const left = drainViolations()
    if (left.length === 0) return
    try {
      process.stderr.write(`${VIOLATION_CODE}: ${left.length} refused operation(s) in this probe:\n${left.map((v) => `  ${v.op}: ${v.target}`).join('\n')}\n`)
    } catch {
      /* stderr closed */
    }
    if (!process.exitCode) process.exitCode = 1
  })
  return state
}

/**
 * Point every home variable back at the isolated folder unless it already points
 * inside the isolated or temp area (a test may give itself its own temp home in
 * module scope or beforeAll; that cannot reach a real home). Unset, real or foreign
 * values never carry into the next test. Recreates the folders a test deleted.
 */
export function reassertHomeEnv() {
  const st = getState()
  if (st) applyIsolatedEnv(st, false)
}

/** Is `v` a path inside the isolated or temp area (and no real home)? @param {GuardState} st @param {string | undefined} v */
function inSafeArea(st, v) {
  if (!nonEmpty(v)) return false
  // A checker whose "real" roots are the isolated and temp folders, built once.
  const safe = (st.safeArea ??= createHomeChecker({ realRoots: [st.isolated ?? '', ...st.tmpRoots].filter(nonEmpty), platform: st.platform }))
  return safe.isProtected(v) && !st.checker.isProtected(v)
}

/**
 * Point `envName` at `dir` unless it already names a folder inside the isolated or temp
 * area (an inherited value from a harness shell elsewhere is replaced). Returns the
 * value in force.
 * @param {string} envName @param {string} dir
 */
export function pinDataDirectory(envName, dir) {
  const st = getState()
  if (!st || !inSafeArea(st, process.env[envName])) process.env[envName] = dir
  return process.env[envName]
}

/** @param {GuardState} st @param {boolean} force set every variable (the first redirect) */
function applyIsolatedEnv(st, force) {
  const iso = st.isolatedEnv
  if (!iso || !st.isolated) return
  const ok = (/** @type {string | undefined} */ v) => !force && inSafeArea(st, v)
  for (const name of [...HOME_VARS, ...XDG_VARS]) {
    if (iso[name] && !ok(process.env[name])) process.env[name] = iso[name]
  }
  if (iso.HOMEDRIVE && iso.HOMEPATH && !ok(envHomeDrivePath(/** @type {any} */ (process.env)))) {
    process.env.HOMEDRIVE = iso.HOMEDRIVE
    process.env.HOMEPATH = iso.HOMEPATH
  }
  // A git or npm config variable naming a real home (npm sets npm_config_* for every
  // script it runs) is pointed into the isolated home, so children inherit a safe one.
  for (const k of Object.keys(process.env)) {
    if (!CONFIG_REDIRECT.test(k)) continue
    const v = process.env[k]
    if (nonEmpty(v) && st.checker.isProtected(v)) {
      process.env[k] = /^GIT_CONFIG_GLOBAL$/i.test(k)
        ? path.join(iso.HOME, '.gitconfig')
        : path.join(iso.HOME, /^npm_config_/i.test(k) ? '.npm-redirect' : '.config-redirect', k.toLowerCase())
    }
  }
  for (const name of [...HOME_VARS, ...XDG_VARS]) if (iso[name]) fs.mkdirSync(iso[name], { recursive: true })
}

/** Throw unless os.homedir() points inside the isolated root (a worker thread keeps its own env). */
export function assertHomeIsolated() {
  const st = getState()
  const iso = st?.isolated
  const home = osHome()
  const inside = iso && home ? createHomeChecker({ realRoots: [iso], platform: process.platform }).isProtected(home) : false
  if (!inside) {
    throw new Error(
      `${VIOLATION_CODE}: home isolation did not take effect: os.homedir() is ${home}, the isolated root is ${iso}. ` +
        "Run vitest with pool 'forks' (a worker thread keeps its own copy of the environment).",
    )
  }
}

/** Remove and return the recorded violations. */
export function drainViolations() {
  const st = getState()
  if (!st) return []
  return st.violations.splice(0, st.violations.length)
}

/** Throw if any violation was recorded since the last drain (used by the vitest hooks). @param {string} phase */
export function assertNoViolations(phase) {
  const left = drainViolations()
  if (left.length === 0) return
  const err = new Error(
    `${VIOLATION_CODE}: ${left.length} operation(s) on a real home were refused during ${phase} ` +
      `(a refusal caught by the code under test still fails the test):\n` +
      left.slice(0, 10).map((v) => `  ${v.op}: ${v.target} (${v.root})`).join('\n'),
  )
  Object.assign(err, { code: VIOLATION_CODE })
  throw err
}

/** The captured real home roots (read-only copy; empty when the guard is not installed). */
export function realHomeRoots() {
  const st = getState()
  return Object.freeze(st ? [...st.realRaw] : [])
}

/** The isolated root the home variables point into, or undefined. */
export function isolatedRoot() {
  return getState()?.isolated
}

/** The home variables as they were before the redirect (read-only; for locating tools, never for writing). */
export function originalHomeEnv() {
  const st = getState()
  return Object.freeze({ ...(st ? st.originalEnv : {}) })
}

/** True when the installed guard would refuse a mutation of `p`. @param {unknown} p */
export function isRealHomePath(p) {
  const st = getState()
  return st ? st.checker.isProtected(p) : false
}

/** Whether the guard is installed in this process. */
export function guardInstalled() {
  return getState() !== undefined
}

/** Which entry installed the guard in this process ('vitest' | 'probe'), or undefined. */
export function guardEntry() {
  return getState()?.entry
}

/** Whether node-pty loaded in this process and its spawn is guarded. */
export function ptyGuarded() {
  return getState()?.ptyGuarded === true
}

/**
 * A FRESH environment for a probe or fake CLI: nothing from process.env except
 * PATH-style essentials, the home variables (and HOMEDRIVE/HOMEPATH on Windows, the
 * XDG folders elsewhere) inside `root`, and the guard preload in NODE_OPTIONS. It
 * carries the caller's real home roots so the child protects them too. Throws if
 * `root` is inside a real home.
 * @param {string} root
 */
export function isolatedProbeEnv(root) {
  if (!nonEmpty(root)) throw new TypeError('isolatedProbeEnv(root): root must be a folder path')
  const abs = path.resolve(root)
  const st = getState()
  const config = st ?? buildConfig()
  const hit = config.checker.classify(abs)
  if (hit) {
    const err = new TestIsolationViolation('isolatedProbeEnv', abs, hit.root, hit.reason)
    if (st) st.violations.push({ op: 'isolatedProbeEnv', target: abs, root: hit.root })
    throw err
  }
  /** @type {Record<string, string>} */ const env = {}
  for (const name of PROBE_ENV_KEEP) {
    for (const k of Object.keys(process.env)) {
      if (k === name || (IS_WIN && k.toUpperCase() === name.toUpperCase())) {
        const v = process.env[k]
        if (nonEmpty(v)) env[k] = v
      }
    }
  }
  const vars = isolatedHomeVars(abs)
  for (const name of [...HOME_VARS, ...XDG_VARS]) if (vars[name]) fs.mkdirSync(vars[name], { recursive: true })
  Object.assign(env, vars)
  env.NODE_OPTIONS = NODE_OPTIONS_IMPORT
  env[MARKER_ENV] = markerValue(config, abs)
  return env
}
