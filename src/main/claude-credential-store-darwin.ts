// macOS Keychain backend for Claude Code's OAuth credential (experimental
// macOS multi-account, src/shared/mac-multi-account.ts).
//
// WHERE CLAUDE CODE KEEPS IT (verified on a Mac, 2026-10-06, manual CLI; see
// CONTEXT.d/2026-10-06-mac-multiaccount.md): a login-keychain GENERIC PASSWORD
//   service  `Claude Code-credentials`                  -- no CLAUDE_CONFIG_DIR
//   service  `Claude Code-credentials-<sha256(dir)[0:8]>` -- CLAUDE_CONFIG_DIR=dir
//   account  the macOS user name ($USER)
// where `dir` is EXACTLY the string passed as CLAUDE_CONFIG_DIR. The stored
// secret is BELIEVED to be the same JSON as `.credentials.json`
// ({"claudeAiOauth":{accessToken,refreshToken,expiresAt,...}}) -- community
// evidence, not verified here -- so every read validates the shape and an
// unrecognised secret is UNKNOWN, never "signed out".
//
// HOW THIS APP TOUCHES IT: only through /usr/bin/security, by absolute path,
// via execFile (never a shell), with a timeout. Claude Code reads its item with
// the same binary, so an item either side creates trusts the same binary.
//
//   read    find-generic-password -a <user> -s <service> -w
//           exit 0 = found, exit 44 (errSecItemNotFound -25300 & 0xff) = not
//           found, anything else (locked keychain, denied, timeout) = unknown.
//   write   `security -i` with ONE command on STDIN (see writeKeychainSecret):
//           argv is just ["-i"], so the secret never appears in the process
//           table (`ps` shows argv to every local user).
//   delete  delete-generic-password -a <user> -s <service>; refuses the
//           unsuffixed default item, always.
//
// Nothing here knows about profiles: account-profiles maps a profile to a
// service name (profileCredentialLocation) and calls in.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'

export const SECURITY_BIN = '/usr/bin/security'

/** The item Claude Code uses with no CLAUDE_CONFIG_DIR: the user's normal
 *  sign-in. This app reads it (the primary account) and, for the usage
 *  refresh, would write it -- but never deletes it. */
export const CLAUDE_KEYCHAIN_DEFAULT_SERVICE = 'Claude Code-credentials'

/** Exit status of `security` when the item does not exist. */
export const SECURITY_EXIT_NOT_FOUND = 44

/** Timeout for one `security` call. A locked keychain can raise an unlock
 *  dialog that blocks the call; past this it is killed and read as UNKNOWN. */
export const SECURITY_TIMEOUT_MS = 8_000

/** security(1)'s interactive reader (SecurityTool/macOS/security.c,
 *  MAX_LINE_LEN 4096) truncates a longer line SILENTLY. A truncated hex
 *  password would store a corrupt secret, so a line at or past this length is
 *  refused before anything is sent. */
export const SECURITY_INTERACTIVE_MAX_LINE = 4000

const SUFFIXED_SERVICE_RE = /^Claude Code-credentials-[0-9a-f]{8}$/

/** The Keychain service for a CLAUDE_CONFIG_DIR string: the default service
 *  plus the first 8 hex of sha256 over the UTF-8 of the NFC string. The input
 *  must be the exact string the launch passes (macProfileConfigDir builds it);
 *  NFC here is a no-op for that string and only guards a caller that forgot. */
export function keychainServiceForConfigDir(dir: string): string {
  if (typeof dir !== 'string' || !dir) throw new Error('a config directory string is required')
  const h = createHash('sha256').update(Buffer.from(dir.normalize('NFC'), 'utf8')).digest('hex').slice(0, 8)
  return `${CLAUDE_KEYCHAIN_DEFAULT_SERVICE}-${h}`
}

/** True for the two service shapes this module will ever touch. */
export function isClaudeKeychainService(service: string): boolean {
  return service === CLAUDE_KEYCHAIN_DEFAULT_SERVICE || SUFFIXED_SERVICE_RE.test(service)
}

// -- process seam ------------------------------------------------------------

export interface SecurityResult {
  /** Exit status, or null when the process was killed / never ran. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SecurityRunner = (args: readonly string[], opts: { input?: string; timeoutMs: number }) => Promise<SecurityResult>

const defaultRunner: SecurityRunner = (args, opts) => new Promise((resolve) => {
  let child: ReturnType<typeof execFile>
  try {
    child = execFile(SECURITY_BIN, [...args], { timeout: opts.timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8', windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null }) | null
      const timedOut = !!e && (e.killed === true || e.signal === 'SIGTERM')
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : null
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut })
    })
  } catch (e) {
    resolve({ code: null, stdout: '', stderr: String((e as Error)?.message ?? e), timedOut: false })
    return
  }
  // The secret, when there is one, travels here and only here.
  try { child.stdin?.end(opts.input ?? '') } catch { /* the callback reports the failure */ }
})

/** The account attribute Claude Code stores its item under: `$USER`, else the
 *  OS user name -- the CLI's own order (adversarial review pass 3, m5). A
 *  different value here would read and write an item the CLI never uses. */
export function defaultKeychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  const u = env.USER
  return typeof u === 'string' && u ? u : os.userInfo().username
}

let runner: SecurityRunner = defaultRunner
let userName: () => string = () => defaultKeychainAccount()

/** Test seam: replace the `security` process and the macOS user name. Also
 *  clears the read coalescing and the negative cache. */
export function _setSecurityRunnerForTest(r: SecurityRunner | null, user?: () => string): void {
  runner = r ?? defaultRunner
  userName = user ?? (() => defaultKeychainAccount())
  _resetKeychainReadCacheForTest()
}

/** Exported for its tests only: the process runner this module uses. */
export const _defaultSecurityRunnerForTest: SecurityRunner = defaultRunner

function account(): string {
  const u = userName()
  if (typeof u !== 'string' || !u) throw new Error('the macOS user name could not be read')
  return u
}

// -- secret shape ------------------------------------------------------------

export interface ClaudeKeychainCreds {
  /** The secret exactly as stored (decoded), for a compare-and-swap. */
  secret: string
  /** The parsed object, every field kept, for a write-back that preserves them. */
  obj: Record<string, unknown>
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number
  refreshTokenExpiresAt?: number
  subscriptionType?: string
}

/** Parse a stored secret. Accepts the `.credentials.json` shape only: a JSON
 *  object with a `claudeAiOauth` object holding an access or refresh token.
 *  Anything else is null -- UNKNOWN to the caller, never "signed out". */
export function parseKeychainSecret(secret: string): ClaudeKeychainCreds | null {
  let obj: unknown
  try { obj = JSON.parse(secret) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = (obj as Record<string, unknown>).claudeAiOauth
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const accessToken = typeof r.accessToken === 'string' && r.accessToken ? r.accessToken : null
  const refreshToken = typeof r.refreshToken === 'string' && r.refreshToken ? r.refreshToken : null
  if (!accessToken && !refreshToken) return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  return {
    secret,
    obj: obj as Record<string, unknown>,
    accessToken,
    refreshToken,
    expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : 0,
    refreshTokenExpiresAt: num(r.refreshTokenExpiresAt),
    subscriptionType: typeof r.subscriptionType === 'string' ? r.subscriptionType : undefined,
  }
}

/** `security -w` prints the password followed by ONE newline, and prints it
 *  as lowercase hex when any byte is not isprint() (a pretty-printed JSON's
 *  newlines, or UTF-8 above 0x7f). Undo both. Exported for its tests. */
export function decodeSecurityPasswordOutput(stdout: string): string {
  const s = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  // JSON never starts with a hex digit pair that decodes to `{` unless it IS
  // hex: a raw secret starts with `{`.
  if (s.length >= 2 && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s)) {
    const decoded = Buffer.from(s, 'hex').toString('utf8')
    if (decoded.trimStart().startsWith('{')) return decoded
  }
  return s
}

// -- read --------------------------------------------------------------------

export type KeychainRead =
  | { status: 'found'; creds: ClaudeKeychainCreds }
  | { status: 'not-found' }
  | { status: 'unknown'; reason: string }

/** How long an UNKNOWN read is reused before `security` is asked again. A
 *  locked Keychain answers every read with an unlock dialog; the 4 s polls
 *  (re-auth stamp, auth info, usage) would otherwise stack dialogs. */
export const KEYCHAIN_UNKNOWN_CACHE_MS = 30_000

/** A `latest` read (a poll that must see an unlock soon, e.g. the re-auth
 *  baseline) starts at most one new `security` process per this interval per
 *  service; in between it gets the shared in-flight read or the last answer
 *  (re-attack round 2, item 3: no spawn every 4 s tick while locked). */
export const KEYCHAIN_LATEST_MIN_INTERVAL_MS = 10_000

const readsInFlight = new Map<string, Promise<KeychainRead>>()
const unknownUntil = new Map<string, { until: number; result: KeychainRead }>()
const lastAnswer = new Map<string, { at: number; result: KeychainRead }>()
/** Bumped by every write/delete: a read that started before a mutation never
 *  records its (stale) answer for later readers. */
const generation = new Map<string, number>()
let nowMs: () => number = () => Date.now()

/** Test seam: forget in-flight reads and cached answers; optionally a clock. */
export function _resetKeychainReadCacheForTest(clock?: () => number): void {
  readsInFlight.clear()
  unknownUntil.clear()
  lastAnswer.clear()
  nowMs = clock ?? (() => Date.now())
}

/** Forget everything shared or cached for `service`: called around every
 *  write and delete, so no later read can be answered by one that started
 *  before the mutation (re-attack round 2, item 2). */
function invalidateService(service: string): void {
  readsInFlight.delete(service)
  unknownUntil.delete(service)
  lastAnswer.delete(service)
  generation.set(service, (generation.get(service) ?? 0) + 1)
}

/**
 * Read a Claude Code Keychain item. Three kinds of read:
 *
 *  - default (status polls: auth info, usage, stamps): concurrent reads of
 *    one service share ONE `security` process, and an UNKNOWN answer is
 *    reused for KEYCHAIN_UNKNOWN_CACHE_MS (pass 3, m9);
 *  - `latest: true` (the re-auth baseline): skips the unknown cache so an
 *    unlock is seen soon, but still shares the in-flight read and starts at
 *    most one process per KEYCHAIN_LATEST_MIN_INTERVAL_MS;
 *  - `fresh: true` (every read a write or delete decision rests on: a
 *    capture's source read and its pre-delete re-read, a refresh's pre-POST
 *    check and compare-before-write, a write's read-back): its own process,
 *    started now, never an answer from a read that began earlier. These are
 *    one-off reads tied to a user action or a rotation, never a timer.
 */
export async function readKeychainCreds(service: string, opts?: { fresh?: boolean; latest?: boolean }): Promise<KeychainRead> {
  if (opts?.fresh) return readKeychainCredsNow(service)
  const inFlight = readsInFlight.get(service)
  if (opts?.latest) {
    if (inFlight) return inFlight
    const last = lastAnswer.get(service)
    if (last && nowMs() - last.at < KEYCHAIN_LATEST_MIN_INTERVAL_MS) return last.result
    return startSharedRead(service)
  }
  const cached = unknownUntil.get(service)
  if (cached && nowMs() < cached.until) return cached.result
  if (inFlight) return inFlight
  return startSharedRead(service)
}

function startSharedRead(service: string): Promise<KeychainRead> {
  const p = readKeychainCredsNow(service).finally(() => { if (readsInFlight.get(service) === p) readsInFlight.delete(service) })
  readsInFlight.set(service, p)
  return p
}

async function readKeychainCredsNow(service: string): Promise<KeychainRead> {
  const gen = generation.get(service) ?? 0
  const r = await readKeychainCredsUncached(service)
  if ((generation.get(service) ?? 0) !== gen) return r // a write/delete ran meanwhile: answer this caller, record nothing
  if (r.status === 'unknown') unknownUntil.set(service, { until: nowMs() + KEYCHAIN_UNKNOWN_CACHE_MS, result: r })
  else unknownUntil.delete(service)
  lastAnswer.set(service, { at: nowMs(), result: r })
  return r
}

async function readKeychainCredsUncached(service: string): Promise<KeychainRead> {
  if (!isClaudeKeychainService(service)) return { status: 'unknown', reason: 'not a Claude Code Keychain service' }
  let user: string
  try { user = account() } catch (e) { return { status: 'unknown', reason: String((e as Error).message) } }
  let r: SecurityResult
  try {
    r = await runner(['find-generic-password', '-a', user, '-s', service, '-w'], { timeoutMs: SECURITY_TIMEOUT_MS })
  } catch (e) {
    return { status: 'unknown', reason: `security could not run: ${(e as Error)?.message ?? e}` }
  }
  if (r.timedOut) return { status: 'unknown', reason: 'the Keychain did not answer in time (locked, or waiting on a dialog)' }
  if (r.code === SECURITY_EXIT_NOT_FOUND) return { status: 'not-found' }
  if (r.code !== 0) return { status: 'unknown', reason: `security exited ${r.code ?? 'abnormally'}` }
  const creds = parseKeychainSecret(decodeSecurityPasswordOutput(r.stdout))
  if (!creds) return { status: 'unknown', reason: 'the Keychain item is not in the expected credential shape' }
  return { status: 'found', creds }
}

/** A generation stamp for the item: a short hash of its secret. One-way and
 *  truncated, so it identifies a change without exposing the token; the
 *  win32/linux stamp is the file's mtime:size, which is no more secret. */
export function keychainStamp(creds: ClaudeKeychainCreds): string {
  return `kc:${createHash('sha256').update(creds.secret, 'utf8').digest('hex').slice(0, 16)}`
}

// -- write -------------------------------------------------------------------

/** Quote one argument for security(1)'s interactive parser (split_line in
 *  SecurityTool/macOS/security.c): inside double quotes a backslash makes the
 *  next character literal and the quote character ends the argument, so `\`
 *  and `"` are escaped and everything else is literal. A line break cannot be
 *  carried at all -- the reader ends the command at it, and the rest would run
 *  as a SECOND command -- so CR, LF and NUL are refused, not escaped. */
export function quoteSecurityInteractiveArg(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('refusing an argument with a line break or NUL for security -i')
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/** The one stdin line `security -i` runs to store `secret` under `service`.
 *  The secret goes as `-X <hex>`: lowercase hex is a charset the parser cannot
 *  misread, so no secret content -- quotes, backslashes, newlines, anything --
 *  can end the argument or start another command. Exported for its tests. */
export function buildAddGenericPasswordLine(user: string, service: string, secret: string): string {
  if (!isClaudeKeychainService(service)) throw new Error('not a Claude Code Keychain service')
  const hex = Buffer.from(secret, 'utf8').toString('hex')
  const line = `add-generic-password -U -a ${quoteSecurityInteractiveArg(user)} -s ${quoteSecurityInteractiveArg(service)} -X ${hex}\n`
  if (Buffer.byteLength(line, 'utf8') >= SECURITY_INTERACTIVE_MAX_LINE) {
    throw new CredentialTooLargeError()
  }
  return line
}

/** The reason a write is refused when its one `security -i` line would reach
 *  SECURITY_INTERACTIVE_MAX_LINE bytes (adversarial review pass 3, m11). */
export const CREDENTIAL_TOO_LARGE_REASON = 'credential too large for the Keychain write path'

export class CredentialTooLargeError extends Error {
  constructor() { super(CREDENTIAL_TOO_LARGE_REASON) }
}

/** The longest secret (in UTF-8 bytes) one write accepts for this account and
 *  service: the line is the fixed text, the quoted account and service, and
 *  two hex characters per secret byte, and must stay BELOW the cap. Exported
 *  for its boundary tests. */
export function maxSecretBytesFor(user: string, service: string): number {
  const fixed = Buffer.byteLength(`add-generic-password -U -a ${quoteSecurityInteractiveArg(user)} -s ${quoteSecurityInteractiveArg(service)} -X \n`, 'utf8')
  return Math.floor((SECURITY_INTERACTIVE_MAX_LINE - 1 - fixed) / 2)
}

export type KeychainWrite = { ok: true } | { ok: false; reason: string }

/**
 * Store `secret` (a credential JSON) in `service`, creating or updating it
 * (-U), then READ IT BACK and require the same bytes: `security -i`'s exit
 * status is the last command's status, but a parse error or partial run must
 * not pass as a write, so success is the read-back, not the exit code.
 *
 * WHY STDIN: `security add-generic-password -w <secret>` (or -X) on argv puts
 * the token in the process table for the life of the call, readable by every
 * local user through `ps`. Here argv is `["-i"]`; the command, the account,
 * the service and the hex secret go through the pipe.
 */
export async function writeKeychainSecret(service: string, secret: string): Promise<KeychainWrite> {
  if (!parseKeychainSecret(secret)) return { ok: false, reason: 'refusing to store a secret that is not a Claude credential' }
  let line: string
  try { line = buildAddGenericPasswordLine(account(), service, secret) } catch (e) { return { ok: false, reason: String((e as Error).message) } }
  let r: SecurityResult
  try {
    invalidateService(service)
    r = await runner(['-i'], { input: line, timeoutMs: SECURITY_TIMEOUT_MS })
  } catch (e) {
    return { ok: false, reason: `security could not run: ${(e as Error)?.message ?? e}` }
  }
  invalidateService(service)
  if (r.timedOut) return { ok: false, reason: 'the Keychain did not answer in time' }
  if (r.code !== 0 || /returned\s+-?\d+/.test(r.stderr)) return { ok: false, reason: `security exited ${r.code ?? 'abnormally'}` }
  const back = await readKeychainCreds(service, { fresh: true })
  if (back.status !== 'found' || back.creds.secret !== secret) return { ok: false, reason: 'the Keychain item did not read back as written' }
  return { ok: true }
}

// -- delete ------------------------------------------------------------------

export type KeychainDelete = 'deleted' | 'not-found' | { unknown: string }

/** Delete a PROFILE's item. The unsuffixed default item -- the user's normal
 *  sign-in -- is refused by shape, whatever the caller passes. */
export async function deleteKeychainItem(service: string): Promise<KeychainDelete> {
  if (!SUFFIXED_SERVICE_RE.test(service)) return { unknown: 'refusing to delete anything but a profile Keychain item' }
  let user: string
  try { user = account() } catch (e) { return { unknown: String((e as Error).message) } }
  let r: SecurityResult
  try {
    invalidateService(service)
    r = await runner(['delete-generic-password', '-a', user, '-s', service], { timeoutMs: SECURITY_TIMEOUT_MS })
  } catch (e) {
    return { unknown: `security could not run: ${(e as Error)?.message ?? e}` }
  }
  invalidateService(service) // whatever happened, it may have changed the item
  if (r.timedOut) return { unknown: 'the Keychain did not answer in time' }
  if (r.code === 0) return 'deleted'
  if (r.code === SECURITY_EXIT_NOT_FOUND) return 'not-found'
  return { unknown: `security exited ${r.code ?? 'abnormally'}` }
}
