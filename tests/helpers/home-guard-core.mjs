// Home guard: tests and probes never act on a real home.
//
// One implementation, two entry points:
//   - tests/helpers/home-isolation.ts (vitest setupFiles[0]) points the home
//     variables at a per-worker folder and installs the guard;
//   - tests/helpers/probe-guard.mjs (`node --import`) installs the same guard in a
//     plain-node probe or fake CLI started with isolatedProbeEnv(root).
// Plain JS so node can load it without a TypeScript loader.
//
// The guard captures the REAL home roots once (HOME, USERPROFILE, APPDATA,
// LOCALAPPDATA, CLAUDE_CONFIG_DIR, CODEX_HOME, HOMEDRIVE+HOMEPATH, os.homedir() and
// os.userInfo().homedir, which ignores the environment, plus any account-profiles
// folder above one of them). From then on these throw TEST_ISOLATION_VIOLATION:
//   - every fs delete, move, write or create whose target resolves inside a real
//     home (sync, callback and fs.promises forms);
//   - every child_process / node-pty spawn whose cwd, or whose HOME, USERPROFILE,
//     APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR or CODEX_HOME value, resolves inside
//     a real home, or whose arguments name a real home or its Claude/Codex config.
// The executable itself may live under a real home: running a binary is not a
// mutation. A path is inside a real home when it is under a real root and not
// under a more specific allowed root: the isolated root, the original temp folder
// (on Windows it sits under LOCALAPPDATA), or the project root (CI runners keep the
// checkout under HOME). Paths are compared after resolving `..`, separators, case
// (win32, darwin), trailing dots and spaces, stream suffixes, device and UNC
// admin-share prefixes, file: URLs and Buffers, and the real path of the nearest
// existing ancestor (so a link from an allowed folder into a real home is caught).
// Every violation is also recorded, so one swallowed by a broad catch still fails
// the test (vitest entry) or the probe's exit code (probe entry).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import childProcess from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

export const VIOLATION_CODE = 'TEST_ISOLATION_VIOLATION'
export const MARKER_ENV = 'CCC_HOME_GUARD'
export const HOME_VARS = Object.freeze(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
// A child whose env omits one of these falls back to the OS profile, a real home,
// so a spawn that omits them gets the isolated value. CLAUDE_CONFIG_DIR and
// CODEX_HOME fall back to HOME/USERPROFILE, which are filled, so leaving them
// unset keeps the child isolated (and keeps code that strips them testable).
const FILL_VARS = Object.freeze(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
// The variables whose absence sends a child to the OS profile on each platform.
const FALLBACK_VARS = Object.freeze(process.platform === 'win32' ? ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] : ['HOME'])
const STATE_KEY = Symbol.for('ccc.test-home-guard.state')
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_NAME = /^\.(claude|codex)/i
// The only variables a fresh probe environment copies from its caller.
const PROBE_ENV_KEEP = Object.freeze(['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM'])

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
 * the URL reading too), a file URL object, or a Buffer / Uint8Array. Anything else
 * (a descriptor, a FileHandle) is not a path and is not checked.
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
  if (input && typeof input === 'object' && typeof (/** @type {any} */ (input).href) === 'string') {
    try {
      return [fileURLToPath(/** @type {any} */ (input).href, { windows })]
    } catch {
      return []
    }
  }
  return []
}

/**
 * Absolute, lexically normalised forms of `str` (original case). `device` means a
 * Win32 device-namespace path that cannot be mapped to a drive or share; callers
 * treat it as a violation (fail closed).
 * @param {string} str @param {string} base @param {string} platform
 * @returns {{ forms: string[], device: boolean }}
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
    else return { forms: [], device: true }
  }
  const abs = P.resolve(base, s)
  const root = P.parse(abs).root
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
  // An administrative share (\\host\C$\...) reaches a local drive: check it as that drive too.
  for (const f of [...forms]) {
    const share = /^\\\\[^\\]+\\([a-z])\$(?:\\|$)/i.exec(f)
    if (share) forms.push(share[1] + ':\\' + f.slice(share[0].length))
  }
  return { forms, device: false }
}

/**
 * The real path of `abs`: the realpath of its nearest existing ancestor with the
 * missing tail appended; a dangling link is followed through its target. Returns
 * null when a link leads into the unmappable device namespace.
 * @param {string} abs @param {FsImpl} fsImpl @param {string} platform @param {number} [hops]
 * @returns {string | null}
 */
function resolveReal(abs, fsImpl, platform, hops = 0) {
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
      if (st.isSymbolicLink() && hops < 40) {
        let target
        try {
          target = fsImpl.readlinkSync(cur)
        } catch {
          target = undefined
        }
        if (typeof target === 'string') {
          const lf = lexicalForms(target, P.dirname(cur), platform)
          if (lf.device) return null
          if (lf.forms.length > 0) {
            const r = resolveReal(lf.forms[0], fsImpl, platform, hops + 1)
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
 * @typedef {{ lstatSync: Function, realpathSync: Function, readlinkSync: Function }} FsImpl
 * @typedef {{ path: string, kind: 'isolated' | 'tmp' | 'project' }} AllowedRoot
 * @typedef {{ root: string, form: string, reason?: string }} Hit
 */

/** @type {FsImpl} */
const REAL_FS = {
  lstatSync: fs.lstatSync,
  realpathSync: fs.realpathSync.native,
  readlinkSync: fs.readlinkSync,
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

/**
 * A pure checker over explicit roots. The installed guard is one of these; tests
 * build their own with simulated roots and a fake fs.
 * @param {{ realRoots: string[], allowedRoots?: AllowedRoot[], configRoots?: string[],
 *   platform?: string, fsImpl?: FsImpl, cwd?: () => string }} opts
 */
export function createHomeChecker(opts) {
  const platform = opts.platform ?? process.platform
  const fsImpl = opts.fsImpl ?? REAL_FS
  const cwd = opts.cwd ?? (() => process.cwd())
  const P = pathApi(platform)
  const sep = P.sep

  /** @param {string} s @param {string} base */
  const formsOf = (s, base) => {
    const lf = lexicalForms(s, base, platform)
    if (lf.device) return { device: true, forms: /** @type {string[]} */ ([]) }
    const out = new Set(lf.forms)
    for (const f of lf.forms) {
      const r = resolveReal(f, fsImpl, platform)
      if (r === null) return { device: true, forms: /** @type {string[]} */ ([]) }
      for (const g of lexicalForms(r, base, platform).forms) out.add(g)
    }
    return { device: false, forms: [...out] }
  }
  /** @param {string[]} list */
  const keysOf = (list) => {
    const out = new Set()
    for (const p of list.filter(nonEmpty)) for (const f of formsOf(p, cwd()).forms) out.add(keyOf(f, platform))
    return /** @type {string[]} */ ([...out])
  }

  const realKeys = keysOf(opts.realRoots)
  const configKeys = keysOf(opts.configRoots ?? [])
  /** @type {{ key: string, kind: string }[]} */
  const allowed = []
  for (const a of opts.allowedRoots ?? []) {
    if (!a || !nonEmpty(a.path)) continue
    for (const k of keysOf([a.path])) allowed.push({ key: k, kind: a.kind })
  }

  /** The real root that makes key `k` protected, or null. @param {string} k */
  const protectedBy = (k) => {
    let real = ''
    for (const r of realKeys) if (within(k, r, sep) && r.length > real.length) real = r
    if (!real) return null
    for (const a of allowed) {
      if (!within(k, a.key, sep)) continue
      // The more specific root wins; on a tie the temp and isolated roots win and
      // the project root does not (a checkout that IS a home stays protected).
      if (a.key.length > real.length || (a.key.length === real.length && a.kind !== 'project')) return null
    }
    return real
  }

  /** @param {unknown} input @param {string} [base] @returns {Hit | null} */
  const classify = (input, base) => {
    const b = base ?? cwd()
    for (const s of pathStrings(input, platform)) {
      const f = formsOf(s, b)
      if (f.device) return { root: '(device namespace)', form: s, reason: 'is a device path the guard cannot map' }
      for (const form of f.forms) {
        const root = protectedBy(keyOf(form, platform))
        if (root) return { root, form }
      }
    }
    return null
  }

  /**
   * Does an argument name a real home itself or the Claude / Codex configuration in
   * one (`.claude*`, `.codex*`, a `.credentials.json`, the original
   * CLAUDE_CONFIG_DIR / CODEX_HOME, an account-profiles folder)?
   * @param {string} token @param {string} [base] @returns {Hit | null}
   */
  const configHit = (token, base) => {
    const b = base ?? cwd()
    /** @type {string[]} */ const candidates = pathStrings(token, platform)
    if (token === '~' || token.startsWith('~/') || token.startsWith('~\\')) {
      for (const r of opts.realRoots.filter(nonEmpty)) candidates.push(r + token.slice(1))
    }
    for (const s of candidates) {
      const f = formsOf(s, b)
      if (f.device) continue
      for (const form of f.forms) {
        const k = keyOf(form, platform)
        const root = protectedBy(k)
        if (!root) continue
        if (k === root) return { root, form, reason: 'names a real home' }
        const first = k.slice(root.length).split(sep).filter(Boolean)[0] ?? ''
        const base2 = k.slice(k.lastIndexOf(sep) + 1)
        if (CONFIG_NAME.test(first) || base2.toLowerCase() === '.credentials.json' || configKeys.some((c) => within(k, c, sep))) {
          return { root, form, reason: 'names a real home configuration' }
        }
      }
    }
    return null
  }

  return {
    platform,
    classify,
    configHit,
    /** @param {unknown} p */
    isProtected: (p) => classify(p) !== null,
    /** @param {string} s @param {string} [base] */
    keysOf: (s, base) => formsOf(s, base ?? cwd()).forms.map((f) => keyOf(f, platform)),
  }
}

// ---------------------------------------------------------------------------
// Capture and state.

/** @param {NodeJS.ProcessEnv | Record<string, unknown>} env @param {string} name @returns {string[]} */
function envValues(env, name) {
  /** @type {string[]} */ const out = []
  const fold = process.platform === 'win32'
  for (const k of Object.keys(env)) {
    if (k === name || (fold && k.toUpperCase() === name)) {
      const v = env[k]
      if (nonEmpty(v)) out.push(v)
    }
  }
  return out
}

/** @param {NodeJS.ProcessEnv | Record<string, unknown>} env */
function envHomeDrivePath(env) {
  const d = envValues(env, 'HOMEDRIVE')[0]
  const p = envValues(env, 'HOMEPATH')[0]
  return d && p ? d + p : undefined
}

function osUserHome() {
  try {
    return os.userInfo().homedir
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
    return { real: list(m.real), config: list(m.config), tmp: list(m.tmp), isolated: nonEmpty(m.isolated) ? m.isolated : undefined }
  } catch {
    return null
  }
}

/** The home variables pointed at `root`. @param {string} root @param {string} [platform] */
export function isolatedHomeVars(root, platform = process.platform) {
  const P = pathApi(platform)
  const home = P.join(root, 'home')
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
  }
  return vars
}

/**
 * Real roots, config roots and allowed roots for the current process.
 * @param {{ extraTmpRoots?: string[], isolated?: string }} [opts]
 */
function buildConfig(opts = {}) {
  const platform = process.platform
  const env = process.env
  const marker = parseMarker(env[MARKER_ENV])
  const tmpRoots = [...new Set([...(opts.extraTmpRoots ?? []), os.tmpdir(), ...(marker ? marker.tmp : [])].filter(nonEmpty).map((p) => path.resolve(p)))]
  const markerIsolated = marker?.isolated
  // A captured value already inside the isolated or temp area is not a real home
  // (a re-load after the redirect, or a probe started with isolatedProbeEnv).
  const notReal = createHomeChecker({
    realRoots: [markerIsolated, ...tmpRoots].filter(nonEmpty),
    platform,
  })
  /** @type {Record<string, string | undefined>} */
  const originalEnv = {}
  for (const name of [...HOME_VARS, 'HOMEDRIVE', 'HOMEPATH']) originalEnv[name] = envValues(env, name)[0]
  const captured = [...HOME_VARS.flatMap((n) => envValues(env, n)), envHomeDrivePath(env), osHome()].filter(nonEmpty)
  const realFromEnv = captured.filter((v) => !notReal.isProtected(v))
  const realRaw = [...new Set([...(marker ? marker.real : []), ...realFromEnv, osUserHome()].filter(nonEmpty).map((p) => path.resolve(p)))]
  const derived = deriveAccountProfilesRoots(realRaw, platform)
  for (const d of derived) if (!realRaw.includes(d)) realRaw.push(d)
  const configRaw = [
    ...new Set(
      [...(marker ? marker.config : []), ...['CLAUDE_CONFIG_DIR', 'CODEX_HOME'].flatMap((n) => envValues(env, n)).filter((v) => !notReal.isProtected(v)), ...derived]
        .filter(nonEmpty)
        .map((p) => path.resolve(p)),
    ),
  ]
  /** @type {AllowedRoot[]} */
  const base = [...tmpRoots.map((p) => /** @type {AllowedRoot} */ ({ path: p, kind: 'tmp' })), { path: PROJECT_ROOT, kind: 'project' }]
  // Accept an isolated root only if it is not itself inside a real home.
  let isolated = opts.isolated ?? markerIsolated
  if (isolated) {
    const probe = createHomeChecker({ realRoots: realRaw, allowedRoots: base, configRoots: configRaw, platform })
    if (probe.isProtected(isolated)) isolated = undefined
  }
  const allowedRoots = isolated ? [{ path: isolated, kind: /** @type {'isolated'} */ ('isolated') }, ...base] : base
  const checker = createHomeChecker({ realRoots: realRaw, allowedRoots, configRoots: configRaw, platform })
  return { platform, realRaw, configRaw, tmpRoots, isolated, checker, originalEnv }
}

/**
 * @typedef {ReturnType<typeof buildConfig> & {
 *   entry: string, isolatedEnv: Record<string, string> | null, ptyGuarded?: boolean,
 *   safeArea?: ReturnType<typeof createHomeChecker>,
 *   violations: { op: string, target: string, root: string }[] }} GuardState
 */

/** @returns {GuardState | undefined} */
function getState() {
  return /** @type {any} */ (process)[STATE_KEY]
}

/** @param {GuardState} state */
function markerValue(state) {
  return JSON.stringify({ v: 1, real: state.realRaw, config: state.configRaw, tmp: state.tmpRoots, isolated: state.isolated })
}

/** @param {GuardState} state @param {string} op @param {unknown} target @param {Hit} hit */
function violation(state, op, target, hit) {
  const shown = typeof target === 'string' ? target : hit.form
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

// Which arguments name a target: indexes, or a rule.
/** @type {[string, number[] | 'open' | 'symlink'][]} */
const FS_DELETE = [
  ['rm', [0]], ['rmSync', [0]], ['rmdir', [0]], ['rmdirSync', [0]], ['unlink', [0]], ['unlinkSync', [0]],
  ['rename', [0, 1]], ['renameSync', [0, 1]],
]
/** @type {[string, number[] | 'open' | 'symlink'][]} */
const FS_WRITE = [
  ['writeFile', [0]], ['writeFileSync', [0]], ['appendFile', [0]], ['appendFileSync', [0]],
  ['mkdir', [0]], ['mkdirSync', [0]], ['mkdtemp', [0]], ['mkdtempSync', [0]],
  ['copyFile', [1]], ['copyFileSync', [1]], ['cp', [1]], ['cpSync', [1]],
  ['symlink', 'symlink'], ['symlinkSync', 'symlink'], ['link', [0, 1]], ['linkSync', [0, 1]],
  ['truncate', [0]], ['truncateSync', [0]], ['chmod', [0]], ['chmodSync', [0]], ['lchmod', [0]], ['lchmodSync', [0]],
  ['chown', [0]], ['chownSync', [0]], ['lchown', [0]], ['lchownSync', [0]],
  ['utimes', [0]], ['utimesSync', [0]], ['lutimes', [0]], ['lutimesSync', [0]],
  ['open', 'open'], ['openSync', 'open'], ['createWriteStream', [0]],
]
/** @type {[string, number[] | 'open' | 'symlink'][]} */
const FS_PROMISES = [
  ['rm', [0]], ['rmdir', [0]], ['unlink', [0]], ['rename', [0, 1]],
  ['writeFile', [0]], ['appendFile', [0]], ['mkdir', [0]], ['mkdtemp', [0]],
  ['copyFile', [1]], ['cp', [1]], ['symlink', 'symlink'], ['link', [0, 1]],
  ['truncate', [0]], ['chmod', [0]], ['lchmod', [0]], ['chown', [0]], ['lchown', [0]],
  ['utimes', [0]], ['lutimes', [0]], ['open', 'open'],
]

const WRITE_FLAG_BITS =
  (fs.constants.O_WRONLY ?? 0) | (fs.constants.O_RDWR ?? 0) | (fs.constants.O_CREAT ?? 0) | (fs.constants.O_TRUNC ?? 0) | (fs.constants.O_APPEND ?? 0)

/** @param {unknown} flags */
function isWriteFlag(flags) {
  if (typeof flags === 'string') return /[wa+]/i.test(flags)
  if (typeof flags === 'number') return (flags & WRITE_FLAG_BITS) !== 0
  return false
}

/** @param {GuardState} state @param {string} op @param {number[] | 'open' | 'symlink'} spec @param {unknown[]} args */
function checkFsCall(state, op, spec, args) {
  const check = (/** @type {unknown} */ target, /** @type {string} */ what, /** @type {string | undefined} */ base = undefined) => {
    const hit = state.checker.classify(target, base)
    if (hit) throw violation(state, what, target, hit)
  }
  if (spec === 'open') {
    if (isWriteFlag(args[1])) check(args[0], op)
    return
  }
  if (spec === 'symlink') {
    check(args[1], op)
    // A link into a real home is the first step of every escape: refuse to make one.
    const linkPath = pathStrings(args[1], state.platform)[0]
    if (linkPath !== undefined) check(args[0], op + ' target', path.dirname(path.resolve(linkPath)))
    return
  }
  for (const i of spec) check(args[i], op)
}

/** @param {GuardState} state @param {any} target @param {string} prefix @param {[string, number[] | 'open' | 'symlink'][]} table @param {boolean} promise */
function wrapFsTable(state, target, prefix, table, promise) {
  for (const [name, spec] of table) {
    const orig = target[name]
    if (typeof orig !== 'function') continue
    const op = prefix + name
    const guarded = promise
      ? function (/** @type {unknown[]} */ ...args) {
          try {
            checkFsCall(state, op, spec, args)
          } catch (e) {
            return Promise.reject(e)
          }
          // @ts-ignore -- forwarding the caller's receiver
          return orig.apply(this, args)
        }
      : function (/** @type {unknown[]} */ ...args) {
          checkFsCall(state, op, spec, args)
          // @ts-ignore -- forwarding the caller's receiver
          return orig.apply(this, args)
        }
    Object.defineProperty(guarded, 'name', { value: name })
    target[name] = guarded
  }
}

// ---------------------------------------------------------------------------
// Spawn guard.

/** Quote-aware split of a command line or argument into words. @param {string} s */
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

/** @param {string[]} words */
function withAssignments(words) {
  /** @type {string[]} */ const out = []
  for (const w of words) {
    out.push(w)
    const eq = w.indexOf('=')
    if (eq >= 0 && eq < w.length - 1) out.push(w.slice(eq + 1))
  }
  return out
}

/**
 * The arguments to check: every argument (whole, split into words, and the value
 * of any `name=value`), never the executable. For a shell command line the first
 * word is the executable.
 * @param {unknown} command @param {unknown[]} argv @param {unknown} execArgv @param {boolean} shell
 */
function spawnTokens(command, argv, execArgv, shell) {
  const out = new Set()
  if (shell && typeof command === 'string') for (const t of withAssignments(shellWords(command).slice(1))) out.add(t)
  const rest = [...argv, ...(Array.isArray(execArgv) ? execArgv : [])]
  for (const v of rest) {
    if (typeof v !== 'string') continue
    out.add(v)
    for (const t of withAssignments(shellWords(v))) out.add(t)
  }
  return /** @type {string[]} */ ([...out].filter((t) => t.length > 0 && t.length <= 4096))
}

/**
 * @param {GuardState} state @param {string} op
 * @param {{ command: unknown, argv: unknown[], options: any, shell: boolean }} call
 * @returns {any} the options to use (a copy with the isolated home filled in when needed)
 */
function checkSpawn(state, op, call) {
  const options = call.options && typeof call.options === 'object' ? call.options : undefined
  const cwdInput = options && options.cwd != null ? options.cwd : process.cwd()
  const cwdHit = state.checker.classify(cwdInput)
  if (cwdHit) throw violation(state, op + ' cwd', cwdInput, cwdHit)
  const cwdAbs = path.resolve(pathStrings(cwdInput, state.platform)[0] ?? process.cwd())

  const explicit = !!(options && options.env && typeof options.env === 'object')
  const env = explicit ? options.env : process.env
  for (const name of HOME_VARS) {
    for (const v of envValues(env, name)) {
      const hit = state.checker.classify(v, cwdAbs)
      if (hit) throw violation(state, `${op} env ${name}`, v, hit)
    }
  }
  const hdp = envHomeDrivePath(env)
  if (hdp) {
    const hit = state.checker.classify(hdp, cwdAbs)
    if (hit) throw violation(state, `${op} env HOMEDRIVE+HOMEPATH`, hdp, hit)
  }

  for (const t of spawnTokens(call.command, call.argv, options && options.execArgv, call.shell || !!(options && options.shell))) {
    const hit = state.checker.configHit(t, cwdAbs)
    if (hit) throw violation(state, op + ' argv', t, hit)
  }

  /** @type {Record<string, string>} */ const fills = {}
  const want = [...FILL_VARS, ...(state.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH'] : [])]
  for (const name of want) {
    if (envValues(env, name).length > 0) continue
    const value = state.isolatedEnv && state.isolatedEnv[name]
    if (value) fills[name] = value
    else if (FALLBACK_VARS.includes(name)) {
      // No isolated home to hand over: the child would fall back to a real one.
      throw violation(state, `${op} env ${name}`, `(unset ${name})`, { root: '(OS profile fallback)', form: name, reason: 'is unset and no isolated home is available' })
    }
  }
  if (Object.keys(fills).length === 0) return call.options
  return { ...(options ?? {}), env: { ...env, ...fills } }
}

/** @param {unknown} v */
function isOptionsObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** @param {GuardState} state @param {string} name @param {unknown[]} args */
function guardSpawnArgs(state, name, args) {
  const a = [...args]
  const shell = name === 'exec' || name === 'execSync'
  /** @type {unknown[]} */ let argv = []
  let optIdx = -1
  if (shell) optIdx = isOptionsObject(a[1]) ? 1 : -1
  else if (Array.isArray(a[1])) {
    argv = a[1]
    optIdx = isOptionsObject(a[2]) ? 2 : -1
  } else if (a[1] == null) optIdx = isOptionsObject(a[2]) ? 2 : -1
  else optIdx = isOptionsObject(a[1]) ? 1 : -1
  const options = optIdx >= 0 ? a[optIdx] : undefined
  const next = checkSpawn(state, 'child_process.' + name, { command: a[0], argv, options, shell })
  if (next === options) return a
  if (optIdx >= 0) a[optIdx] = next
  else if (shell) a.splice(1, 0, next)
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
      // @ts-ignore -- forwarding the caller's receiver
      return orig.apply(this, guardSpawnArgs(state, name, args))
    }
    Object.defineProperty(guarded, 'name', { value: name })
    // util.promisify(exec / execFile) uses this symbol, which calls the original:
    // route it through the guard too.
    const custom = orig[util.promisify.custom]
    if (typeof custom === 'function') {
      Object.defineProperty(guarded, util.promisify.custom, {
        value: function (/** @type {unknown[]} */ ...args) {
          // @ts-ignore -- forwarding the caller's receiver
          return custom.apply(this, guardSpawnArgs(state, name, args))
        },
        configurable: true,
      })
    }
    cp[name] = guarded
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
      const next = checkSpawn(state, 'node-pty.' + name, { command: file, argv, options: opt, shell: false })
      // @ts-ignore -- forwarding the caller's receiver
      return orig.call(this, file, args, next)
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Install and the read-only API.

/**
 * Install the guard once per process (later calls return the installed state).
 * `isolate` creates a fresh isolated root under the original temp folder and points
 * the home variables at it (the vitest entry); without it the isolated root is the
 * one a caller handed over through isolatedProbeEnv (the probe entry).
 * @param {{ entry: 'vitest' | 'probe', isolate?: boolean, extraTmpRoots?: string[] }} opts
 * @returns {GuardState}
 */
export function installHomeGuard(opts) {
  const existing = getState()
  if (existing) return existing
  let isolatedRoot
  if (opts.isolate) {
    const origTmp = (opts.extraTmpRoots ?? []).find(nonEmpty) ?? os.tmpdir()
    // A sibling of the per-worker temp root, never inside it: some code treats a home
    // below os.tmpdir() differently. The `ccc-vitest-` prefix lets global-setup sweep it.
    isolatedRoot = fs.mkdtempSync(path.join(origTmp, 'ccc-vitest-home-'))
  }
  const config = buildConfig({ extraTmpRoots: opts.extraTmpRoots, isolated: isolatedRoot })
  /** @type {GuardState} */
  const state = {
    ...config,
    entry: opts.entry,
    isolatedEnv: config.isolated ? isolatedHomeVars(config.isolated, config.platform) : null,
    violations: [],
  }
  Object.defineProperty(process, STATE_KEY, { value: state, enumerable: false, configurable: false, writable: false })

  wrapFsTable(state, fs, 'fs.', FS_DELETE, false)
  wrapFsTable(state, fs, 'fs.', FS_WRITE, false)
  wrapFsTable(state, fs.promises, 'fs.promises.', FS_PROMISES, true)
  patchChildProcess(state)
  state.ptyGuarded = patchNodePty(state)
  // `import { rmSync } from 'fs'`, `import * as fs from 'node:fs'`, fs/promises and
  // child_process named imports read the ESM bindings: bring them in line.
  syncBuiltinESMExports()

  if (opts.isolate && isolatedRoot) {
    applyIsolatedEnv(state, true)
    const root = isolatedRoot
    process.once('exit', () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort; global-setup sweeps ccc-vitest-* */
      }
    })
  }
  process.env[MARKER_ENV] = markerValue(state)
  if (opts.entry === 'probe') {
    process.once('exit', () => {
      const left = drainViolations()
      if (left.length === 0) return
      try {
        process.stderr.write(`${VIOLATION_CODE}: ${left.length} refused operation(s) in this probe:\n${left.map((v) => `  ${v.op}: ${v.target}`).join('\n')}\n`)
      } catch {
        /* stderr closed */
      }
      if (!process.exitCode) process.exitCode = 1
    })
  }
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

/** @param {GuardState} st @param {boolean} force set every variable (the first redirect) */
function applyIsolatedEnv(st, force) {
  const iso = st.isolatedEnv
  if (!iso || !st.isolated) return
  // "Inside the isolated or temp area", built once: a checker whose roots are those.
  const safe = (st.safeArea ??= createHomeChecker({ realRoots: [st.isolated, ...st.tmpRoots], platform: st.platform }))
  const ok = (/** @type {string | undefined} */ v) => !force && nonEmpty(v) && safe.isProtected(v) && !st.checker.isProtected(v)
  for (const name of HOME_VARS) {
    if (!ok(process.env[name])) process.env[name] = iso[name]
  }
  if (iso.HOMEDRIVE && iso.HOMEPATH && !ok(envHomeDrivePath(process.env))) {
    process.env.HOMEDRIVE = iso.HOMEDRIVE
    process.env.HOMEPATH = iso.HOMEPATH
  }
  process.env[MARKER_ENV] = markerValue(st)
  for (const name of HOME_VARS) fs.mkdirSync(iso[name], { recursive: true })
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

/** Whether node-pty loaded in this process and its spawn is guarded. */
export function ptyGuarded() {
  return getState()?.ptyGuarded === true
}

/**
 * A FRESH environment for a probe or fake CLI: nothing from process.env except
 * PATH-style essentials, and HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
 * CLAUDE_CONFIG_DIR and CODEX_HOME (and HOMEDRIVE/HOMEPATH on Windows) inside
 * `root`. Carries the caller's real home roots so `--import probe-guard.mjs` in the
 * child protects them too. Throws if `root` is inside a real home.
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
      if (k === name || (process.platform === 'win32' && k.toUpperCase() === name.toUpperCase())) {
        const v = process.env[k]
        if (nonEmpty(v)) env[k] = v
      }
    }
  }
  const vars = isolatedHomeVars(abs)
  for (const name of HOME_VARS) fs.mkdirSync(vars[name], { recursive: true })
  Object.assign(env, vars)
  env[MARKER_ENV] = JSON.stringify({ v: 1, real: config.realRaw, config: config.configRaw, tmp: config.tmpRoots, isolated: abs })
  return env
}
