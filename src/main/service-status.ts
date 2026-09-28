/**
 * Service status poller: each provider's public status page, read every 5
 * minutes ONLY while that provider is on (OD27 D5: a provider that is off
 * makes no calls), and pushed to the renderer for the title bar's status
 * pills (parity rows 14 and 45).
 *
 * Claude Code: Anthropic's Statuspage. Tracks Claude Code (the CLI/IDE
 * product), claude.ai (web app), and the Claude API (api.anthropic.com, which
 * both depend on).
 * Codex: OpenAI's status page, which serves the same components list. Tracks
 * the Codex CLI and the Codex API; OpenAI's other products are not read.
 *
 * A reply is read defensively: a 200 only (a redirect is never followed), a
 * bounded body, a status the app knows (anything else is no status), and
 * only the app's own ids and labels reach the renderer, never remote text.
 * Time is bounded: each read has an overall deadline besides the socket's
 * idle timeout, each provider's page is read and published on its own, and
 * a provider switched off, or the poller stopped, aborts its read in flight.
 * A page that fails two polls in a row reads as "status unknown" (its
 * components null, its read time kept) rather than freezing its last pill.
 * A send to a window being torn down never escapes as an error. A burst of
 * accounts-service changes is acted on once, after it.
 */
import * as https from 'https'
import type { ClientRequest } from 'http'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { ProviderId } from '../shared/providers'
import { appWindowSender } from './ipc/trusted-sender'
import { logInfo } from './debug-logger'

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes
/** The socket's idle timeout. */
const REQUEST_TIMEOUT = 8000
/** The whole read, however the bytes arrive: a reply that drips slower than
 *  the idle timeout is cut here. */
const REQUEST_DEADLINE = 15_000
/** Failed polls in a row after which a page's last reading is dropped to
 *  "status unknown". */
const STALE_AFTER_FAILURES = 2
/** A components list is a few KB; anything this large is not one. */
const MAX_BODY_BYTES = 1024 * 1024

export interface ServiceComponentStatus {
  /** The status page's component ID (the app's own constant) */
  id: string
  /** Display name for the title bar (the app's own label) */
  label: string
  /** "operational" | "degraded_performance" | "partial_outage" | "major_outage" | "under_maintenance" */
  status: string
}

export interface ServiceStatusPayload {
  /** ISO timestamp the payload was built */
  fetchedAt: string
  /** Claude Code component (most relevant: what this app drives). Null while Claude Code is off. */
  claudeCode: ServiceComponentStatus | null
  /** Claude.ai web app. Null while Claude Code is off. */
  claudeAi: ServiceComponentStatus | null
  /** Claude API: both Code and .ai depend on it. Null while Claude Code is off. */
  api: ServiceComponentStatus | null
  /** The Codex CLI, from OpenAI's status page. Null while Codex is off. */
  codexCli: ServiceComponentStatus | null
  /** The Codex API, from OpenAI's status page. Null while Codex is off. */
  codexApi: ServiceComponentStatus | null
  /** When Anthropic's page was last read; null while Claude Code is off,
   *  and before its first successful read. */
  claudeReadAt: string | null
  /** When OpenAI's page was last read; null while Codex is off, and before
   *  its first successful read. */
  codexReadAt: string | null
  /** Convenience: highest-severity status across the providers that are on */
  worst: string
}

type ComponentKey = 'claudeCode' | 'claudeAi' | 'api' | 'codexCli' | 'codexApi'
type ReadKey = 'claudeReadAt' | 'codexReadAt'

interface StatusSource {
  providerId: ProviderId
  readKey: ReadKey
  url: string
  components: ReadonlyArray<{ key: ComponentKey; id: string; label: string }>
}

// Component IDs from each page's /api/v2/components.json (OpenAI's checked
// 2026-09-28: "CLI" and "Codex API", the two Codex rows of its page).
const SOURCES: readonly StatusSource[] = [
  {
    providerId: 'claude',
    readKey: 'claudeReadAt',
    url: 'https://status.claude.com/api/v2/components.json',
    components: [
      { key: 'claudeCode', id: 'yyzkbfz2thpt', label: 'Claude Code' },
      { key: 'claudeAi', id: 'rwppv331jlwc', label: 'Claude.ai' },
      { key: 'api', id: 'k8w3r06qmzrp', label: 'API' },
    ],
  },
  {
    providerId: 'codex',
    readKey: 'codexReadAt',
    url: 'https://status.openai.com/api/v2/components.json',
    components: [
      { key: 'codexCli', id: '01KMKFAMWKNQ84Z1766MV08ZDE', label: 'Codex CLI' },
      { key: 'codexApi', id: '01KMP3KP5MGE23B80K1EK4S8PV', label: 'Codex API' },
    ],
  },
]

const SEVERITY: Record<string, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
}

function worstStatus(statuses: (string | undefined)[]): string {
  let max = 'operational'
  let maxRank = 0
  for (const s of statuses) {
    if (!s) continue
    const r = SEVERITY[s] ?? 0
    if (r > maxRank) {
      maxRank = r
      max = s
    }
  }
  return max
}

interface Read {
  /** The parsed JSON, or null for any failure, the deadline or an abort. */
  result: Promise<unknown>
  /** Give up now: the socket is destroyed and the result is null. */
  abort: () => void
}

/** GET a JSON document: a 200 with a body under the cap, inside the
 *  deadline, parsed; else null. Never follows a redirect. */
function fetchJson(url: string): Read {
  let req: ClientRequest | null = null
  let done = false
  let deadline: ReturnType<typeof setTimeout> | null = null
  let settle: (v: unknown) => void = () => {}
  const result = new Promise<unknown>((resolve) => { settle = resolve })
  const finish = (v: unknown, destroy: boolean) => {
    if (done) return
    done = true
    if (deadline) clearTimeout(deadline)
    if (destroy) { try { req?.destroy() } catch { /* already gone */ } }
    settle(v)
  }
  const fail = () => finish(null, true)
  try {
    req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
      if (res.statusCode !== 200) { res.resume(); fail(); return }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) { fail(); return }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (done) return
        let json: unknown = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json = null }
        finish(json, false)
      })
      res.on('error', fail)
    })
    req.on('error', fail)
    req.on('timeout', fail)
    deadline = setTimeout(fail, REQUEST_DEADLINE)
  } catch {
    fail()
  }
  return { result, abort: fail }
}

type SourceReading = Partial<Record<ComponentKey, ServiceComponentStatus | null>>

/** One source's components, or null when the reply is not a components list.
 *  A tracked component missing, or with a status the app does not know,
 *  reads as no status (null). Nothing from the reply is kept but the status,
 *  and that only as one of the known values. */
function parseComponents(source: StatusSource, json: unknown): SourceReading | null {
  const list = (json as { components?: unknown } | null)?.components
  if (!Array.isArray(list)) return null
  const reading: SourceReading = {}
  for (const tracked of source.components) {
    const c = list.find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && (x as { id?: unknown }).id === tracked.id)
    const status = typeof c?.status === 'string' && Object.hasOwn(SEVERITY, c.status) ? c.status : null
    reading[tracked.key] = status ? { id: tracked.id, label: tracked.label, status } : null
  }
  return reading
}

export interface ServiceStatusDeps {
  /** Whether the provider is on now (its saved on/off, as main answers it). */
  providerOn: (providerId: ProviderId) => boolean
  /** Told of every change the accounts service publishes, so a switch made
   *  there (not a settings save) reaches the poller at once. Returns an
   *  unsubscribe. */
  subscribe?: (listener: () => void) => () => void
}

interface SourceState {
  reading: SourceReading | null
  at: string | null
  read: Read | null
  pending: Promise<void>
  /** Failed polls in a row (a success resets it). */
  failures: number
}

let timer: ReturnType<typeof setInterval> | null = null
let started = false
let deps: ServiceStatusDeps | null = null
let unsubscribe: (() => void) | null = null
let getWin: (() => BrowserWindow | null) | null = null
// Each source's last good reading, when it was taken, and its read in
// flight; the reading is dropped while its provider is off.
const states = new Map<ReadKey, SourceState>()
// The providers on at the last poll: a settings save polls again only when
// this changed.
let lastOn = ''
// A refresh waiting for the end of a burst of accounts-service changes (a
// lease taken and given back, a registry write): the burst is acted on once,
// so each provider's on/off, a read of the saved settings, is asked once per
// burst rather than once per change.
let queuedRefresh: ReturnType<typeof setImmediate> | null = null
// Last payload. Cached so a renderer that mounts AFTER the immediate poll has
// already fired (e.g. behind the startup splash) can pull the current status
// synchronously instead of waiting up to a full poll interval for the next
// push. Fixes the title-bar status pills not appearing until ~5 min after
// launch.
let lastPayload: ServiceStatusPayload | null = null

/** The most recent status payload, or null if none built yet. */
export function getLastServiceStatus(): ServiceStatusPayload | null {
  return lastPayload
}

function isOn(providerId: ProviderId): boolean {
  try { return deps?.providerOn(providerId) === true } catch { return false }
}

function onSet(): string {
  return SOURCES.filter((s) => isOn(s.providerId)).map((s) => s.providerId).join(',')
}

function stateOf(source: StatusSource): SourceState {
  let s = states.get(source.readKey)
  if (!s) { s = { reading: null, at: null, read: null, pending: Promise.resolve(), failures: 0 }; states.set(source.readKey, s) }
  return s
}

function buildPayload(): ServiceStatusPayload {
  const component = (key: ComponentKey): ServiceComponentStatus | null => {
    for (const s of states.values()) {
      const c = s.reading?.[key]
      if (c) return c
    }
    return null
  }
  const claudeCode = component('claudeCode')
  const claudeAi = component('claudeAi')
  const api = component('api')
  const codexCli = component('codexCli')
  const codexApi = component('codexApi')
  return {
    fetchedAt: new Date().toISOString(),
    claudeCode,
    claudeAi,
    api,
    codexCli,
    codexApi,
    claudeReadAt: states.get('claudeReadAt')?.at ?? null,
    codexReadAt: states.get('codexReadAt')?.at ?? null,
    worst: worstStatus([claudeCode, claudeAi, api, codexCli, codexApi].map((c) => c?.status)),
  }
}

/** Build the payload and push it. The push never throws: a window being
 *  torn down can throw from send, and the payload is still kept for the
 *  next pull. */
function publish(): void {
  lastPayload = buildPayload()
  try {
    const win = getWin?.()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SERVICE_STATUS, lastPayload)
  } catch {
    // The window is going away; nothing to tell.
  }
}

/** Stop a source's read in flight; its late reply is ignored. */
function abortRead(s: SourceState): void {
  const read = s.read
  s.read = null
  read?.abort()
}

/** One source, on its own: off aborts its read and drops its reading (no
 *  call); on reads it, one read at a time, and publishes when it lands. */
function pollSource(source: StatusSource): Promise<void> {
  const s = stateOf(source)
  if (!started || !isOn(source.providerId)) {
    abortRead(s)
    s.failures = 0
    if (s.reading) { s.reading = null; s.at = null; publish() }
    return Promise.resolve()
  }
  if (s.read) return s.pending
  const read = fetchJson(source.url)
  s.read = read
  s.pending = read.result.then((json) => {
    // Aborted (switched off, stopped) or superseded: nothing from it is kept.
    if (s.read !== read) return
    s.read = null
    let reading: SourceReading | null = null
    try { reading = parseComponents(source, json) } catch { reading = null }
    if (!started || !isOn(source.providerId)) return
    if (!reading) {
      // One failed poll leaves the last reading; two in a row drop it to
      // "status unknown" (every component null), keeping when it was read.
      s.failures++
      if (s.failures >= STALE_AFTER_FAILURES && s.reading && Object.values(s.reading).some((c) => c)) {
        s.reading = Object.fromEntries(source.components.map((c) => [c.key, null])) as SourceReading
        publish()
      }
      return
    }
    s.failures = 0
    s.reading = reading
    s.at = new Date().toISOString()
    publish()
  })
  return s.pending
}

/** Every source, each settling on its own (the promise is only for callers
 *  that want to wait for all of them). */
function pollAll(): Promise<void> {
  lastOn = onSet()
  return Promise.all(SOURCES.map(pollSource)).then(() => undefined)
}

/** Only the sources whose provider was switched on or off since the last
 *  poll: on reads it at once, off aborts its read and drops its reading. */
function pollSwitched(): Promise<void> {
  const was = new Set(lastOn.split(',').filter(Boolean))
  lastOn = onSet()
  const now = new Set(lastOn.split(',').filter(Boolean))
  const switched = SOURCES.filter((s) => was.has(s.providerId) !== now.has(s.providerId))
  return Promise.all(switched.map(pollSource)).then(() => undefined)
}

export function startServiceStatusPoller(
  getWindow: () => BrowserWindow | null,
  serviceDeps: ServiceStatusDeps,
): void {
  if (started) return
  getWin = getWindow
  deps = serviceDeps
  started = true
  logInfo('[service-status] Starting poller (5 min interval, each provider\'s status page while it is on)')
  const quietly = (p: Promise<void>) => { p.catch(() => { /* a poll never escapes as an error */ }) }
  quietly(pollAll()) // fetch immediately
  timer = setInterval(() => { quietly(pollAll()) }, POLL_INTERVAL)
  unsubscribe = serviceDeps.subscribe?.(() => {
    if (queuedRefresh) return
    queuedRefresh = setImmediate(() => {
      queuedRefresh = null
      quietly(refreshServiceStatus())
    })
  }) ?? null
}

function dropQueuedRefresh(): void {
  if (queuedRefresh) clearImmediate(queuedRefresh)
  queuedRefresh = null
}

/** The saved settings changed: a provider switched on is read at once, and
 *  one switched off leaves the payload, its read in flight aborted. Nothing
 *  is read when no provider's on/off changed, and a provider whose on/off
 *  did not change is not read again. It covers every change before it, so a
 *  refresh still waiting for the end of a burst is dropped. */
export function refreshServiceStatus(): Promise<void> {
  dropQueuedRefresh()
  if (!started) return Promise.resolve()
  return pollSwitched()
}

/** The renderer's pull of the cached payload: the app's own window, its top
 *  frame only (trusted-sender.ts); anything else gets nothing. */
export function registerServiceStatusHandlers(getWindow: () => BrowserWindow | null): void {
  const trusted = appWindowSender(getWindow)
  ipcMain.handle(IPC.SERVICE_STATUS_GET, (e) => (trusted(e) ? lastPayload : null))
}

export function stopServiceStatusPoller(): void {
  try { unsubscribe?.() } catch { /* already gone */ }
  unsubscribe = null
  dropQueuedRefresh()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  started = false
  for (const s of states.values()) abortRead(s)
}
