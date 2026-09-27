/**
 * Usage track MP7 (ADR-022; the owner's scoped WP1.41 exception): the client
 * side of one `codex app-server` usage read, as a pure state machine over an
 * injected writer and the helper's stdout. No process, no timer, no file.
 *
 * What it may send is fixed and code-built, nothing else:
 *   1. `initialize`: clientInfo naming the Codex CLI and its proven version,
 *      `capabilities: null` (no experimental API, no other capability);
 *   2. the `initialized` notification;
 *   3. `account/rateLimits/read` with no parameters (so never
 *      `supportsLunaReserve` or any other opt-in).
 * Never a conversation, thread or turn method, and never an answer to a
 * request from the server: such a request fails the read.
 *
 * What it accepts: one JSON message per line, at most APP_SERVER_MAX_LINE
 * characters; only its two responses by id (a notification is ignored); the
 * `initialize` answer must name the realm the helper was started in
 * (`codexHome`, compared canonically, caseless on Windows and macOS) and
 * the version the client was started for (its `userAgent`,
 * `<name>/<version> ...`: the executable run is the one discovery proved),
 * and both answers must match the schema excerpts
 * (tests/fixtures/codex/app-server/<version>/usage-schema.json): their required
 * fields present with their types, own plain properties only, anything extra
 * accepted and ignored. The allowance then goes through the same normaliser
 * a rollout's does (percentages clamped, reset times bounded, the plan from
 * the known list).
 *
 * The verdict, once, fails closed: `unsupported` (sticky for that CLI until it
 * changes; only an answer about the CLI's version or protocol: method not
 * found, an invalid request, a schema mismatch, a version the client cannot
 * name) or `transient` (a wrong home, which is about the realm and not the
 * CLI; a malformed or oversized line; a helper reporting another version; a
 * timeout, an early exit, a spawn failure, a cancel, an error answer from the
 * backend, a request from the server, or no reading at all). On any verdict the client
 * closes the helper's stdin (`finish`), and the caller ends the process chain.
 */

import type { AllowanceReading } from '../../../shared/usage-types'
import { normaliseCodexRateLimits } from './rate-limits'

/** The longest line (one message) the client reads, in characters. */
export const APP_SERVER_MAX_LINE = 64 * 1024
/** The whole read, from spawn to answer. */
export const APP_SERVER_READ_DEADLINE_MS = 20_000
/** The `initialize` answer. */
export const APP_SERVER_INITIALIZE_TIMEOUT_MS = 12_000
/** After the answer (stdin closed), the helper's time to exit on its own
 *  before its process chain is killed. */
export const APP_SERVER_EXIT_GRACE_MS = 3_000
/** How the client names itself: the Codex CLI (parity with the Claude usage
 *  call, which presents as Claude Code). */
export const APP_SERVER_CLIENT_NAME = 'codex_cli_rs'

const INITIALIZE_ID = 1
const READ_ID = 2
/** JSON-RPC's method-not-found, invalid-request and invalid-params codes. */
const METHOD_NOT_FOUND = -32601
const INVALID_REQUEST = -32600
const INVALID_PARAMS = -32602

export type AppServerFailure =
  | 'version' | 'method-not-found' | 'invalid-request' | 'schema' | 'malformed' | 'oversized' | 'codex-home'
  | 'version-mismatch' | 'server-request' | 'error-response' | 'no-reading' | 'timeout' | 'exit' | 'spawn' | 'cancelled'

/** The only sticky verdicts: answers about the CLI's version or protocol
 *  (usage track MP7 round 1, D-1). */
const UNSUPPORTED: ReadonlySet<AppServerFailure> = new Set<AppServerFailure>(['version', 'method-not-found', 'invalid-request', 'schema'])

export type AppServerVerdict =
  | { ok: true; reading: AllowanceReading }
  | { ok: false; kind: 'unsupported' | 'transient'; reason: AppServerFailure }

export interface AppServerClientDeps {
  /** Writes one message: a JSON text and a line break. */
  send(line: string): void
  /** Closes the helper's stdin; called once, with the verdict. */
  finish(): void
  /** The realm the helper runs in (its canonical home). */
  realmHome: string
  platform: NodeJS.Platform
  /** The proven CLI version, as discovery read it. */
  cliVersion: string
  now(): number
}

export interface AppServerUsageClient {
  /** Sends `initialize`. */
  begin(): void
  /** The helper's stdout, as it arrives. */
  receive(chunk: string): void
  /** The run ended (or was stopped) before a verdict. */
  ended(reason: 'timeout' | 'exit' | 'spawn' | 'cancelled'): void
  /** The `initialize` answer has arrived and was accepted. */
  readonly initialized: boolean
  readonly verdict: AppServerVerdict | null
}

/** The three messages, exactly: built here, from constants and a checked
 *  version, never from anything the helper said. */
export function appServerMessages(cliVersion: string): { initialize: string; initialized: string; read: string } {
  return {
    initialize: JSON.stringify({ id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: APP_SERVER_CLIENT_NAME, title: null, version: cliVersion }, capabilities: null } }),
    initialized: JSON.stringify({ method: 'initialized' }),
    read: JSON.stringify({ id: READ_ID, method: 'account/rateLimits/read' }),
  }
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined)
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || v === null || ok(v)
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v)
const isStr = (v: unknown) => typeof v === 'string'

/** A RateLimitWindow: `usedPercent` an integer; the rest optional. */
function windowOk(w: unknown): boolean {
  if (w === undefined || w === null) return true
  if (!isPlain(w)) return false
  return isInt(own(w, 'usedPercent')) && optional(own(w, 'resetsAt'), isInt) && optional(own(w, 'windowDurationMins'), isInt)
}

/** A RateLimitSnapshot: every field optional, each of its type. */
function snapshotOk(s: unknown): boolean {
  if (!isPlain(s)) return false
  return windowOk(own(s, 'primary')) && windowOk(own(s, 'secondary'))
    && optional(own(s, 'limitId'), isStr) && optional(own(s, 'limitName'), isStr) && optional(own(s, 'planType'), isStr)
}

/** The `account/rateLimits/read` answer: `rateLimits` required, the per-limit
 *  map optional; anything else is accepted and ignored. */
function readResultOk(r: unknown): boolean {
  if (!isPlain(r) || !snapshotOk(own(r, 'rateLimits'))) return false
  const byId = own(r, 'rateLimitsByLimitId')
  if (byId === undefined || byId === null) return true
  if (!isPlain(byId)) return false
  return Object.keys(byId).every((k) => snapshotOk(byId[k]))
}

/** The `initialize` answer: its four required strings. */
function initializeResultOk(r: unknown): r is Record<string, unknown> & { codexHome: string; userAgent: string } {
  return isPlain(r) && ['codexHome', 'platformFamily', 'platformOs', 'userAgent'].every((k) => isStr(own(r, k)) && (k !== 'codexHome' || (own(r, k) as string).length > 0))
}

/** A path as the comparison reads it: separators unified on Windows, a
 *  `\\?\UNC\` prefix read as the `\\` of the share it names and any other
 *  `\\?\` prefix dropped, trailing separators trimmed; caseless on Windows
 *  and macOS. */
function canonicalHome(p: string, platform: NodeJS.Platform): string {
  let s = p
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\')
    if (s.toLowerCase().startsWith('\\\\?\\unc\\')) s = `\\\\${s.slice(8)}`
    else if (s.startsWith('\\\\?\\')) s = s.slice(4)
  }
  s = s.replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s
}

export function createAppServerUsageClient(deps: AppServerClientDeps): AppServerUsageClient {
  let state: 'new' | 'initializing' | 'reading' | 'done' = 'new'
  let verdict: AppServerVerdict | null = null
  let buffer = ''
  const decide = (v: AppServerVerdict) => {
    if (verdict) return
    verdict = v
    state = 'done'
    buffer = ''
    try { deps.finish() } catch { /* the caller ends the chain regardless */ }
  }
  const fail = (reason: AppServerFailure) => decide({ ok: false, kind: UNSUPPORTED.has(reason) ? 'unsupported' : 'transient', reason })
  const send = (line: string) => { try { deps.send(`${line}\n`) } catch { fail('exit') } }

  const onResponse = (id: unknown, msg: Record<string, unknown>) => {
    const error = own(msg, 'error')
    const expected = state === 'initializing' ? INITIALIZE_ID : state === 'reading' ? READ_ID : null
    if (id !== expected) { fail('schema'); return }
    if (error !== undefined) {
      const code = isPlain(error) ? own(error, 'code') : undefined
      fail(code === METHOD_NOT_FOUND ? 'method-not-found' : code === INVALID_REQUEST || code === INVALID_PARAMS ? 'invalid-request' : 'error-response')
      return
    }
    const result = own(msg, 'result')
    if (state === 'initializing') {
      if (!initializeResultOk(result)) { fail('schema'); return }
      if (canonicalHome(result.codexHome, deps.platform) !== canonicalHome(deps.realmHome, deps.platform)) { fail('codex-home'); return }
      // The helper names its own version first in its user agent
      // (`codex_cli_rs/0.155.1 (...)`): it must be the version the client was
      // started for, else the executable run is not the one proved.
      const agent = /^[^\s/]+\/(\S+)/.exec(result.userAgent)
      if (!agent || agent[1] !== deps.cliVersion) { fail('version-mismatch'); return }
      state = 'reading'
      const m = appServerMessages(deps.cliVersion)
      send(m.initialized)
      if (state === 'reading') send(m.read)
      return
    }
    if (!readResultOk(result)) { fail('schema'); return }
    let now = Date.now()
    try { const n = deps.now(); if (Number.isFinite(n)) now = n } catch { /* the wall clock */ }
    let reading: AllowanceReading | null = null
    try { reading = normaliseCodexRateLimits(result, 'app-server', now, now) } catch { reading = null }
    if (!reading || reading.limits.length === 0) { fail('no-reading'); return }
    decide({ ok: true, reading })
  }

  const onLine = (line: string) => {
    if (!line.trim()) return
    let msg: unknown
    try { msg = JSON.parse(line) } catch { fail('malformed'); return }
    if (!isPlain(msg)) { fail('malformed'); return }
    const method = own(msg, 'method')
    const id = own(msg, 'id')
    if (method !== undefined) {
      if (!isStr(method)) { fail('malformed'); return }
      // A request from the server (an approval, a sign-in refresh) is never
      // answered: it fails the read. A notification is ignored.
      if (id !== undefined) fail('server-request')
      return
    }
    if (typeof id !== 'number' && typeof id !== 'string') { fail('malformed'); return }
    onResponse(id, msg)
  }

  return {
    begin() {
      if (state !== 'new') return
      if (typeof deps.cliVersion !== 'string' || !VERSION_RE.test(deps.cliVersion)) { fail('version'); return }
      state = 'initializing'
      send(appServerMessages(deps.cliVersion).initialize)
    },
    receive(chunk: string) {
      if (verdict || typeof chunk !== 'string') return
      buffer += chunk
      for (;;) {
        if (verdict) return
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.length > APP_SERVER_MAX_LINE) { fail('oversized'); return }
        onLine(line)
      }
      if (buffer.length > APP_SERVER_MAX_LINE) fail('oversized')
    },
    ended(reason) {
      fail(reason === 'timeout' || reason === 'spawn' || reason === 'cancelled' ? reason : 'exit')
    },
    get initialized() { return state === 'reading' || (verdict !== null && verdict.ok) },
    get verdict() { return verdict },
  }
}
