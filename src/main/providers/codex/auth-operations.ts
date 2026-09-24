// Codex sign-in, status and logout for one realm (WP2, plan A6, A7; design
// 5.4, 9.2, 11, 12, 13). Every operation runs the genuine CLI -- the
// executable setup proved, re-verified before EVERY run and never resolved a
// second time -- under the allowlisted environment with CODEX_HOME set to the
// realm, and is judged only by `codex login status` and exit codes. auth.json
// is never opened.
//
// What this package does NOT own is injected: the realm RECORD behind an
// opaque reference (the composition root looks it up in the registry, so the
// package never imports the store) and the API key behind a single-use handle
// (the secret-entry channel). The package itself turns the record into a
// CODEX_HOME with codexRealmHome, so a lookup can never hand it an arbitrary
// path. Lifecycle, lease and consumer checks belong to the accounts service
// that calls these operations.
//
// Rules enforced here, whoever the caller is:
// - the realm home must exist at its canonical path (the CLI canonicalises
//   CODEX_HOME, and the lock and the .env check must see the folder it uses);
//   the realm lock is keyed on the folder's file identity, so no two
//   spellings of one folder run at once, and the identity is read again the
//   moment the lock is taken; the lock is shared with folder removal;
// - while the external home overlaps the managed homes, every realm refuses
//   with its own code;
// - a sign-in never runs over an existing one (the pinned CLI clears the
//   realm's credentials before it tries the new login), and never into an
//   external realm (another client's home);
// - an external realm is logged out only with an explicit acknowledgement;
// - a managed realm is app-created and must hold no `.env`: the CLI loads
//   CODEX_HOME/.env, which could carry OPENAI_API_KEY past the allowlist;
// - one sign-in or sign-out at a time per realm, and one browser sign-in at a
//   time overall (the CLI's local callback port is machine-wide);
// - sign-in and logout succeed only when a status run in the same realm
//   agrees afterwards; after a failed or cancelled sign-in the realm's state
//   is read again and reported, because the user may have finished in the
//   browser just as it was stopped;
// - the API key is taken from its handle FIRST, so a refused sign-in never
//   leaves it waiting; it must be printable ASCII with no surrounding space
//   (exactly what the CLI will store and could echo), reaches the child only
//   through its stdin pipe, and is redacted from the output -- whole, and any
//   16-character run of it;
// - results carry a machine-readable code and fixed, user-safe messages --
//   never CLI output, a key, a path or a login URL. Streamed output is
//   display-only, redacted per stream line by line, and a partial line left
//   by a failed or cut-off run is dropped rather than shown.
// - nothing throws: every odd port answer fails closed with a code.
import path from 'node:path'
import type { AuthMethod, AuthRealm, KnownAuthState, RealmOwnership } from '../../../shared/providers'
import type {
  ProviderAuthOperations, RealmRef, AuthOperationResult, AuthLoginInput, AuthLogoutOptions, AuthFailureCode, AuthCredentialKind, LaunchPreparation,
} from '../core'
import { redactSecrets } from '../../hooks/hook-payload-redactor'
import { redactTokens } from '../../github/security/token-redactor'
import { parseCodexLoginStatus } from './cli-contract'
import type { CodexLoginVia } from './cli-contract'
import { codexCommandLine, codexShellEnv } from './cli-runner'
import type { CodexCliOperation, CodexCommand, CodexRunOptions, CodexRunResult } from './cli-runner'
import { codexCliEnv } from './cli-env'
import { verifyCodexExecutable, codexCompatibilityAllowsUse } from './discovery'
import type { CodexDiscovery, CodexDiscoveryDeps } from './discovery'
import { codexRealmHome } from './realm-paths'
import { createCodexRealmLocks, codexRealmLockKey } from './realm-folders'
import type { CodexRealmLocks } from './realm-folders'
import type { CodexRealmRoots } from './realm-paths'

export type CodexRealmLookup =
  | { ok: true; realm: Pick<AuthRealm, 'id' | 'providerId' | 'kind' | 'ownership' | 'pathRef'>; roots: CodexRealmRoots }
  | { ok: false }

/** A realm home as the filesystem sees it. */
export interface CodexRealmIdentity { canonical: string; dev: string; ino: string; isDirectory: boolean }

export interface CodexAuthDeps {
  /** The realm record behind an opaque reference and the roots its home is
   *  derived from, looked up in the registry (injected by the composition
   *  root). */
  lookupRealm(realm: RealmRef): Promise<CodexRealmLookup>
  /** The canonical path and file identity of a realm home. Throws when it
   *  cannot be read (a missing folder included). */
  realmIdentity(home: string): CodexRealmIdentity
  /** The executable setup last proved, or null when it has not. */
  proven(): CodexDiscovery | null
  /** How to re-resolve and re-read it now (the discovery ports). */
  executablePorts: Pick<CodexDiscoveryDeps, 'resolve' | 'realpath' | 'stat' | 'platform'>
  /** The environment to allowlist from (on macOS and Linux with the login
   *  shell's PATH). */
  baseEnv(): Promise<Readonly<Record<string, string | undefined>>>
  run(cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult>
  /** Is anything at <home>/.env? Anything but `false` -- a throw included --
   *  counts as yes. */
  envFilePresent(home: string): boolean
  /** Single use: the API key a main-issued handle stands for, then forgotten.
   *  Absent: API-key sign-in is unavailable. */
  takeSecret?(handle: string): string | null
  /** The realm locks, shared with folder removal so a folder is never removed
   *  under a running sign-in. Absent: this instance keeps its own. */
  locks?: CodexRealmLocks
}

const STATUS_TIMEOUT_MS = 30_000
const LOGOUT_TIMEOUT_MS = 30_000
const API_KEY_LOGIN_TIMEOUT_MS = 60_000
/** Browser and device sign-in wait on the user; the device code itself
 *  expires after 15 minutes. */
const INTERACTIVE_LOGIN_TIMEOUT_MS = 16 * 60_000
const MIN_API_KEY_LENGTH = 20
const MAX_API_KEY_LENGTH = 4096

/** The sign-in methods Codex has here, and what status must say afterwards. */
function loginSpec(method: unknown): { op: CodexCliOperation; expect: CodexLoginVia; timeoutMs: number } | null {
  switch (method) {
    case 'browser': return { op: 'login-browser', expect: 'chatgpt', timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS }
    case 'device': return { op: 'login-device', expect: 'chatgpt', timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS }
    case 'apiKey': return { op: 'login-api-key', expect: 'api-key', timeoutMs: API_KEY_LOGIN_TIMEOUT_MS }
    default: return null
  }
}

const MSG: Readonly<Record<AuthFailureCode, string>> = {
  'realm-unavailable': 'The Codex account folder is missing or could not be used.',
  'external-overlap': "Your own Codex folder setting (CODEX_HOME, else ~/.codex) overlaps the app's Codex account folders, or cannot be checked. Set CODEX_HOME to a full path outside the app's data folder, or unset it, then try again.",
  'cli-unavailable': 'Check the Codex CLI in setup first.',
  'realm-env-file': 'This managed Codex account folder contains a .env file, which could override its sign-in. Remove it, then try again.',
  'busy': 'A sign-in, sign-out or folder change is already running for this Codex account.',
  'browser-busy': 'Another browser sign-in is already running. Finish or cancel it first.',
  'already-signed-in': 'This Codex account is already signed in. Sign out first to sign in again.',
  'external-realm': 'Sign in with a new managed Codex account; this app does not sign in to the external Codex home.',
  'external-ack-required': 'This is the external Codex home, which other Codex tools on this computer also use. Signing out affects them too; confirm to continue.',
  'method-unsupported': 'Codex does not support this sign-in method here.',
  'secret-unavailable': 'The API key entry has expired or was already used. Enter the key again.',
  'secret-channel-unavailable': 'API-key sign-in is not available here.',
  'secret-invalid': 'That does not look like an API key: it must be at least 20 printable characters, with no spaces or line breaks.',
  'cancelled': 'Sign-in was cancelled.',
  'timed-out': 'The Codex CLI did not finish in time.',
  'not-started': 'The Codex CLI could not be run.',
  'provider-refused': 'Codex did not complete the operation. Its output says why.',
  'not-confirmed': 'Codex did not confirm the sign-in in this account folder.',
  'status-unrecognised': 'Codex did not report a sign-in state this app recognises.',
  'still-signed-in': 'Codex still reports this account as signed in.',
}
const CLI_TOO_OLD = 'This Codex CLI version cannot be used for sign-in. Update it, then check it again in setup.'
const CLI_CHANGED = 'The Codex CLI changed or moved since setup checked it. Check it again in setup.'
const SIGNED_IN_ANYWAY = 'Codex reports this account signed in regardless; check it before you use it.'

type Refusal = { ok: false; code: AuthFailureCode; message: string }
const refuse = (code: AuthFailureCode, message: string = MSG[code]): Refusal => ({ ok: false, code, message })
const isRefusal = (x: unknown): x is Refusal => !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false

type Env = Readonly<Record<string, string | undefined>>
interface Ready { ok: true; home: string; ownership: RealmOwnership; lock: string; base: Env }
type Observed = { state: 'signed-in'; via?: CodexLoginVia } | { state: 'signed-out' } | Refusal & { state: 'error' }

const credentialOf = (via: CodexLoginVia | undefined): AuthCredentialKind => (via === 'chatgpt' ? 'account' : via === 'api-key' ? 'api-key' : 'unknown')

/** Exactly what the CLI will store: one trailing line break (how a pasted key
 *  arrives) is dropped; anything else outside printable ASCII -- a space, a
 *  control or format character -- is refused, not cleaned up, so the value
 *  sent is the value redacted. */
function normaliseApiKey(raw: string): string | null {
  const v = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw
  return v.length >= MIN_API_KEY_LENGTH && v.length <= MAX_API_KEY_LENGTH && /^[\x21-\x7e]+$/.test(v) ? v : null
}

/** The auth operations plus the launch preparation that shares their realm
 *  and executable checks. */
export type CodexAuthOperations = ProviderAuthOperations & {
  prepareLaunch(realm: RealmRef): Promise<LaunchPreparation | Refusal>
  sessionsDir(realm: RealmRef): Promise<string | null>
}

export function createCodexAuthOperations(deps: CodexAuthDeps): CodexAuthOperations {
  const platform = deps.executablePorts.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const caseless = platform === 'win32' || platform === 'darwin'
  const samePath = (a: string, b: string) => {
    const norm = (p: string) => { const s = p.replace(/[\\/]+$/, ''); return caseless ? s.toLowerCase() : s }
    return norm(a) === norm(b)
  }
  const locks = deps.locks ?? createCodexRealmLocks()
  let browserRunning = false

  /** The executable setup proved, re-verified now; the path to run. */
  function currentExecutable(): { ok: true; executable: string } | Refusal {
    let p: CodexDiscovery | null
    try { p = deps.proven() } catch { p = null }
    if (!p || p.state !== 'found' || !p.identity) return refuse('cli-unavailable')
    if (!codexCompatibilityAllowsUse(p.compatibility)) return refuse('cli-unavailable', CLI_TOO_OLD)
    try {
      const check = verifyCodexExecutable(p.identity, deps.executablePorts)
      return check && check.ok && typeof check.executable === 'string' ? { ok: true, executable: check.executable } : refuse('cli-unavailable', CLI_CHANGED)
    } catch {
      return refuse('cli-unavailable', CLI_CHANGED)
    }
  }

  /** The realm's home and ownership, from the looked-up record. Anything odd
   *  about the reference or the record -- a throwing getter included -- is
   *  `realm-unavailable`. */
  async function locate(ref: RealmRef): Promise<{ ok: true; home: string; ownership: RealmOwnership } | Refusal> {
    try {
      const id = ref && typeof ref === 'object' ? (ref as { authRealmId?: unknown }).authRealmId : undefined
      if (typeof id !== 'string' || !id) return refuse('realm-unavailable')
      const found: CodexRealmLookup = await deps.lookupRealm({ authRealmId: id })
      if (!found || found.ok !== true || !found.realm || found.realm.id !== id || !found.roots) return refuse('realm-unavailable')
      const ownership = found.realm.ownership
      if (ownership !== 'conductor-managed' && ownership !== 'external-default') return refuse('realm-unavailable')
      if (found.roots.externalConflict === true) return refuse('external-overlap')
      const where = codexRealmHome(found.realm, found.roots, pathApi)
      return where.ok ? { ok: true, home: where.home, ownership } : refuse('realm-unavailable')
    } catch {
      return refuse('realm-unavailable')
    }
  }

  async function prepare(ref: RealmRef, purpose: 'status' | 'login' | 'logout' | 'launch'): Promise<Ready | Refusal> {
    const where = await locate(ref)
    if (isRefusal(where)) return where
    const ownership = where.ownership
    let fsid: CodexRealmIdentity
    try { fsid = deps.realmIdentity(where.home) } catch { return refuse('realm-unavailable') }
    if (!fsid || fsid.isDirectory !== true || typeof fsid.canonical !== 'string' || !samePath(fsid.canonical, where.home)) return refuse('realm-unavailable')
    const exe = currentExecutable()
    if (!exe.ok) return exe
    if (ownership === 'conductor-managed' && purpose !== 'logout') {
      let present: unknown
      try { present = deps.envFilePresent(where.home) } catch { present = true }
      if (present !== false) return refuse('realm-env-file')
    }
    let base: Env
    try { base = await deps.baseEnv() } catch { return refuse('not-started') }
    if (!base || typeof base !== 'object') return refuse('not-started')
    return { ok: true, home: where.home, ownership, lock: codexRealmLockKey(fsid.canonical, fsid.dev, fsid.ino), base }
  }

  /** One run, from the executable re-verified for THIS run. */
  async function run(r: Ready, op: CodexCliOperation, opts: Omit<CodexRunOptions, 'env'>): Promise<CodexRunResult | Refusal> {
    const exe = currentExecutable()
    if (!exe.ok) return exe
    try {
      const cmd = codexCommandLine(exe.executable, op, platform, codexShellEnv(r.base, platform))
      if ('refused' in cmd) return refuse('not-started')
      const out = await deps.run(cmd, { ...opts, env: codexCliEnv(r.base, r.home, platform) })
      return out && typeof out === 'object' && !isRefusal(out) ? out : refuse('not-started')
    } catch {
      return refuse('not-started')
    }
  }

  async function readStatus(r: Ready): Promise<Observed> {
    const out = await run(r, 'status', { timeoutMs: STATUS_TIMEOUT_MS })
    if (isRefusal(out)) return { ...out, state: 'error' }
    if (out.timedOut) return { ...refuse('timed-out'), state: 'error' }
    if (out.spawnError) return { ...refuse('not-started'), state: 'error' }
    const s = parseCodexLoginStatus(out.exitCode, out.stdout, out.stderr)
    if (s.state === 'signed-in') return { state: 'signed-in', via: s.via }
    if (s.state === 'signed-out') return { state: 'signed-out' }
    return { ...refuse('status-unrecognised'), state: 'error' }
  }

  /** Hold the realm for one sign-in or sign-out; null when it is taken. */
  /** Take the realm's lock, then prove it is still the folder the lock is
   *  keyed on: prepare() awaited (the environment -- a login shell) after it
   *  read the folder's identity, and a folder removed and re-made in that gap
   *  would otherwise run under a dead key, beside a removal or a second
   *  sign-in. Nothing awaits between the hold and the re-read. */
  function holdRealm(r: Ready, mode: 'exclusive' | 'reader' = 'exclusive'): (() => void) | Refusal {
    const release = mode === 'reader' ? locks.holdReader(r.lock) : locks.hold(r.lock)
    if (!release) return refuse('busy')
    let same = false
    try {
      const now = deps.realmIdentity(r.home)
      same = !!now && now.isDirectory === true && typeof now.canonical === 'string' && samePath(now.canonical, r.home)
        && codexRealmLockKey(now.canonical, now.dev, now.ino) === r.lock
    } catch {
      same = false
    }
    if (!same) {
      release()
      return refuse('realm-unavailable')
    }
    return release
  }

  /** Nothing escapes as a rejection: an unexpected throw is a refusal. */
  async function guard<T extends AuthOperationResult>(body: () => Promise<T>, extra: Partial<T> = {}): Promise<T | (Refusal & Partial<T>)> {
    try { return await body() } catch { return { ...extra, ...refuse('not-started') } }
  }

  return {
    /** What a session or reviewer launch in this realm needs, proven now
     *  (plan A10): the canonical home, the executable setup proved and
     *  re-verified, the base environment, and no `.env` in a managed realm.
     *  Not a CLI run, so no realm lock: the caller's account lease keeps the
     *  folder from being removed. */
    async prepareLaunch(realm: RealmRef): Promise<LaunchPreparation | Refusal> {
      try {
        const r = await prepare(realm, 'launch')
        if (isRefusal(r)) return r
        const exe = currentExecutable()
        if (!exe.ok) return exe
        return {
          ok: true, home: r.home, executable: exe.executable, baseEnv: r.base,
          realmEnv: { set: { CODEX_HOME: r.home } },
          sessionsDir: pathApi.join(r.home, 'sessions'),
        }
      } catch {
        return refuse('not-started')
      }
    },

    /** The realm's transcript folder, for the usage index (plan A13): located
     *  exactly as a launch locates it, and nothing else checked. */
    async sessionsDir(realm: RealmRef): Promise<string | null> {
      try {
        const where = await locate(realm)
        return isRefusal(where) ? null : pathApi.join(where.home, 'sessions')
      } catch {
        return null
      }
    },

    status(realm) {
      return guard(async () => {
        const r = await prepare(realm, 'status')
        if (isRefusal(r)) return { ...r, state: 'error' as KnownAuthState }
        // A reader: beside a sign-in, never during a folder removal.
        const release = holdRealm(r, 'reader')
        if (isRefusal(release)) return { ...release, state: 'error' as KnownAuthState }
        try {
          const s = await readStatus(r)
          if (s.state === 'error') return s
          return s.state === 'signed-in' ? { ok: true, state: s.state, credential: credentialOf(s.via) } : { ok: true, state: s.state }
        } finally {
          release()
        }
      }, { state: 'error' as KnownAuthState }) as Promise<{ state: KnownAuthState } & AuthOperationResult>
    },

    logout(realm, opts?: AuthLogoutOptions) {
      return guard(async (): Promise<AuthOperationResult> => {
        const r = await prepare(realm, 'logout')
        if (isRefusal(r)) return r
        if (r.ownership !== 'conductor-managed' && opts?.acknowledgeExternalRealm !== true) return refuse('external-ack-required')
        const release = holdRealm(r)
        if (isRefusal(release)) return release
        try {
          const out = await run(r, 'logout', { timeoutMs: LOGOUT_TIMEOUT_MS })
          if (isRefusal(out)) return out
          if (out.timedOut) return refuse('timed-out')
          if (out.spawnError) return refuse('not-started')
          // The verdict is the realm's state afterwards, not logout's exit code.
          const s = await readStatus(r)
          if (s.state === 'signed-out') return { ok: true, state: 'signed-out' }
          if (s.state === 'signed-in') return { ...refuse('still-signed-in'), state: 'signed-in', credential: credentialOf(s.via) }
          return refuse(s.code, s.message)
        } finally {
          release()
        }
      })
    },

    login(realm, method: AuthMethod, input?: AuthLoginInput) {
      return guard(async (): Promise<AuthOperationResult> => {
        // The key first, whatever happens next -- even when the method is
        // wrong for it: a handle is single-use and a refusal must not leave it
        // parked.
        let key: string | null = null
        const handle = input ? input.secretHandle : undefined
        if (handle !== undefined && typeof handle !== 'string') return refuse('secret-unavailable')
        if (handle && deps.takeSecret) {
          try {
            const v = deps.takeSecret(handle)
            key = typeof v === 'string' ? v : null
          } catch {
            key = null
          }
        }
        const spec = loginSpec(method)
        if (!spec) return refuse('method-unsupported')
        if (method !== 'apiKey' && handle !== undefined) return refuse('method-unsupported')
        if (method === 'apiKey') {
          if (!deps.takeSecret) return refuse('secret-channel-unavailable')
          if (key === null) return refuse('secret-unavailable')
          key = normaliseApiKey(key)
          if (key === null) return refuse('secret-invalid')
        }
        const r = await prepare(realm, 'login')
        if (isRefusal(r)) return r
        if (r.ownership !== 'conductor-managed') return refuse('external-realm')
        const browser = spec.op === 'login-browser'
        if (browser && browserRunning) return refuse('browser-busy')
        const release = holdRealm(r)
        if (isRefusal(release)) return release
        if (browser) browserRunning = true
        const show = (t: string) => { try { input?.onOutput?.(t) } catch { /* the display never breaks the sign-in */ } }
        const secrets = key !== null ? [key] : []
        const display = { stdout: createCodexOutputRedactor(show, secrets), stderr: createCodexOutputRedactor(show, secrets) }
        try {
          const before = await readStatus(r)
          if (before.state === 'signed-in') return { ...refuse('already-signed-in'), state: 'signed-in', credential: credentialOf(before.via) }
          if (before.state !== 'signed-out') return refuse(before.code, before.message)
          const out = await run(r, spec.op, {
            timeoutMs: spec.timeoutMs,
            signal: input?.signal,
            onOutput: (text, stream) => (stream === 'stderr' ? display.stderr : display.stdout).push(text),
            ...(key !== null ? { stdin: `${key}\n` } : {}),
          })
          // A run that ended cleanly may show its last partial line; one that
          // was stopped, failed to start or was cut off may have been cut
          // mid-secret, so its partial line is dropped.
          const whole = !isRefusal(out) && !out.spawnError && !out.timedOut && !out.truncated && !out.stopped
          for (const d of [display.stdout, display.stderr]) { if (whole) d.flush(); else d.discard() }
          if (isRefusal(out)) return out
          let failure: Refusal | null = null
          if (out.spawnError === 'cancelled') failure = refuse('cancelled')
          else if (out.timedOut) failure = refuse('timed-out')
          else if (out.spawnError) failure = refuse('not-started')
          else if (out.exitCode !== 0) failure = refuse('provider-refused')
          const after = await readStatus(r)
          if (!failure) {
            if (after.state === 'signed-in' && after.via === spec.expect) return { ok: true, state: 'signed-in', credential: credentialOf(after.via) }
            // A check that could not run says why; one that ran and disagrees says so.
            return after.state === 'error' ? refuse(after.code, after.message) : { ...refuse('not-confirmed'), state: after.state }
          }
          if (after.state === 'signed-in') return { ...failure, message: `${failure.message} ${SIGNED_IN_ANYWAY}`, state: 'signed-in', credential: credentialOf(after.via) }
          return after.state === 'signed-out' ? { ...failure, state: 'signed-out' } : failure
        } finally {
          display.stdout.discard()
          display.stderr.discard()
          key = null
          if (browser) browserRunning = false
          release()
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// The display redactor for sign-in output.
// ---------------------------------------------------------------------------

/** A partial line that grows past this is withheld whole, because a secret
 *  could straddle wherever it were cut. A complete line of any length is
 *  shown, redacted. */
const MAX_LINE = 4096
/** Any run of this many characters of a known secret is redacted, so a secret
 *  split, cut or spliced by the output is still caught. */
const SECRET_FRAGMENT = 16

// CSI with its parameters; OSC, DCS, SOS, PM and APC up to their terminator;
// other two-byte escapes -- each in its 7-bit and 8-bit form, as whole units,
// so no escape leaves its payload behind inside a secret.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b|\x9b[0-?]*[ -/]*[@-~]?|[\x90\x98\x9d\x9e\x9f][^\x07\x1b\x9c]*(?:\x07|\x9c|\x1b\\)?/g
// Then any control character left but tab (C1 included: U+009B is a CSI to a
// terminal), and every Unicode format character: the bidirectional controls
// that make displayed text read in another order, and the zero-width ones
// that can split a secret invisibly.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const FORMAT = /\p{Cf}/gu

/** The distinct SECRET_FRAGMENT-character runs of a secret. */
function fragmentsOf(secret: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (let i = 0; i + SECRET_FRAGMENT <= secret.length; i++) out.add(secret.slice(i, i + SECRET_FRAGMENT))
  return out
}

/** Replace every run of a secret of at least SECRET_FRAGMENT characters: one
 *  pass over the line, each window looked up in the secret's set -- linear in
 *  the line, whatever the secret looks like. */
function redactFragments(s: string, fragments: ReadonlySet<string>): string {
  if (!fragments.size || s.length < SECRET_FRAGMENT) return s
  const mask = new Uint8Array(s.length)
  let any = false
  for (let at = 0; at + SECRET_FRAGMENT <= s.length; at++) {
    if (fragments.has(s.slice(at, at + SECRET_FRAGMENT))) {
      mask.fill(1, at, at + SECRET_FRAGMENT)
      any = true
    }
  }
  if (!any) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (!mask[i]) out += s[i]
    else if (i === 0 || !mask[i - 1]) out += '[REDACTED]'
  }
  return out
}

export interface CodexOutputRedactor {
  push(text: string): void
  /** Show a final partial line. Idempotent. */
  flush(): void
  /** Drop a final partial line unseen. Idempotent. */
  discard(): void
}

/** One stream's display redactor. Line-buffered: a line is shown only once it
 *  is whole, so a secret split across chunks is redacted like any other.
 *  Terminal escapes and control characters are removed (the output is
 *  untrusted display data), then the exact `secrets` given and any long run
 *  of them, then the app's secret and token patterns. `emit` receives whole
 *  lines ending in a newline. Give each stream its own: two streams through
 *  one buffer can splice a line of one into the middle of the other. */
export function createCodexOutputRedactor(emit: (line: string) => void, secrets: readonly string[] = []): CodexOutputRedactor {
  const exact = secrets.filter((s) => typeof s === 'string' && s.length >= 4)
  const fragments = exact.map(fragmentsOf)
  let buf = ''
  let dropping = false
  const send = (line: string) => { try { emit(line) } catch { /* the display never breaks the sign-in */ } }
  const clean = (line: string) => {
    let s = line.replace(ESCAPES, '').replace(CONTROLS, '').replace(FORMAT, '')
    exact.forEach((secret, i) => { s = redactFragments(s.split(secret).join('[REDACTED]'), fragments[i]) })
    return redactTokens(redactSecrets(s))
  }
  const line = (raw: string) => {
    if (dropping) { dropping = false; return }
    send(`${clean(raw)}\n`)
  }
  return {
    push(text) {
      if (typeof text !== 'string' || !text) return
      buf += text.replace(/\r/g, '')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        line(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
      if (buf.length > MAX_LINE) {
        if (!dropping) send('[a very long output line was withheld]\n')
        dropping = true
        buf = ''
      }
    },
    flush() {
      const rest = buf
      buf = ''
      if (rest) line(rest)
      dropping = false
    },
    discard() {
      buf = ''
      dropping = false
    },
  }
}
