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
 * A reply is read defensively: a 200 only, a bounded body, a status the app
 * knows (anything else is no status), and the app's own labels.
 */
import * as https from 'https'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { ProviderId } from '../shared/providers'
import { logInfo } from './debug-logger'

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes
const REQUEST_TIMEOUT = 8000
/** A components list is a few KB; anything this large is not one. */
const MAX_BODY_BYTES = 1024 * 1024
const MAX_NAME_CHARS = 100

export interface ServiceComponentStatus {
  /** The status page's component ID */
  id: string
  /** Display name for the title bar (short) */
  label: string
  /** "operational" | "degraded_performance" | "partial_outage" | "major_outage" | "under_maintenance" */
  status: string
  /** Component name from the status page (bounded) */
  name: string
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

/** GET a JSON document: a 200 with a body under the cap, parsed; else null. */
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: unknown) => { if (!done) { done = true; resolve(v) } }
    const req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(null); return }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) { finish(null); res.destroy(); req.destroy(); return }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (done) return
        try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish(null) }
      })
      res.on('error', () => finish(null))
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => { req.destroy(); finish(null) })
  })
}

type SourceReading = Partial<Record<ComponentKey, ServiceComponentStatus | null>>

/** One source's components, or null when the reply is not a components list.
 *  A tracked component missing, or with a status the app does not know,
 *  reads as no status (null). */
function parseComponents(source: StatusSource, json: unknown): SourceReading | null {
  const list = (json as { components?: unknown } | null)?.components
  if (!Array.isArray(list)) return null
  const reading: SourceReading = {}
  for (const tracked of source.components) {
    const c = list.find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && (x as { id?: unknown }).id === tracked.id)
    const status = typeof c?.status === 'string' && Object.hasOwn(SEVERITY, c.status) ? c.status : null
    reading[tracked.key] = c && status
      ? { id: tracked.id, label: tracked.label, status, name: typeof c.name === 'string' ? c.name.slice(0, MAX_NAME_CHARS) : tracked.label }
      : null
  }
  return reading
}

export interface ServiceStatusDeps {
  /** Whether the provider is on now (its saved on/off, as main answers it). */
  providerOn: (providerId: ProviderId) => boolean
}

let timer: ReturnType<typeof setInterval> | null = null
let started = false
let deps: ServiceStatusDeps | null = null
let getWin: (() => BrowserWindow | null) | null = null
// Each source's last good reading and when it was taken; dropped while its
// provider is off.
const readings = new Map<ReadKey, { reading: SourceReading; at: string }>()
// The providers on at the last poll: a settings save polls again only when
// this changed.
let lastOn = ''
let inFlight: Promise<void> | null = null
let pollAgain = false
// Last payload. Cached so a renderer that mounts AFTER the immediate poll has
// already fired (e.g. behind the startup splash) can pull the current status
// synchronously via getLastServiceStatus() instead of waiting up to a full
// poll interval for the next push. Fixes the title-bar status pills not
// appearing until ~5 min after launch.
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

function buildPayload(): ServiceStatusPayload {
  const component = (key: ComponentKey): ServiceComponentStatus | null => {
    for (const r of readings.values()) {
      const c = r.reading[key]
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
    claudeReadAt: readings.get('claudeReadAt')?.at ?? null,
    codexReadAt: readings.get('codexReadAt')?.at ?? null,
    worst: worstStatus([claudeCode, claudeAi, api, codexCli, codexApi].map((c) => c?.status)),
  }
}

async function pollOnce(): Promise<void> {
  lastOn = onSet()
  let changed = false
  await Promise.all(SOURCES.map(async (source) => {
    if (!isOn(source.providerId)) {
      // Off: no call, and its last reading leaves the payload.
      if (readings.delete(source.readKey)) changed = true
      return
    }
    const reading = parseComponents(source, await fetchJson(source.url))
    // A provider switched off while its read was out keeps nothing from it.
    if (reading && isOn(source.providerId)) {
      readings.set(source.readKey, { reading, at: new Date().toISOString() })
      changed = true
    }
  }))
  // A failed read changes nothing: the last payload stands.
  if (!changed) return
  lastPayload = buildPayload()
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.SERVICE_STATUS, lastPayload)
}

/** Poll now, or once more after the poll already running. */
function poll(): Promise<void> {
  if (inFlight) { pollAgain = true; return inFlight }
  inFlight = (async () => {
    try {
      do { pollAgain = false; await pollOnce() } while (pollAgain)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function startServiceStatusPoller(
  getWindow: () => BrowserWindow | null,
  serviceDeps: ServiceStatusDeps,
): void {
  getWin = getWindow
  deps = serviceDeps
  started = true
  logInfo('[service-status] Starting poller (5 min interval, each provider\'s status page while it is on)')
  void poll() // fetch immediately
  timer = setInterval(() => { void poll() }, POLL_INTERVAL)
}

/** The saved settings changed: a provider switched on is read at once, and
 *  one switched off leaves the payload. Nothing is read when no provider's
 *  on/off changed. */
export function refreshServiceStatus(): Promise<void> {
  if (!started || onSet() === lastOn) return Promise.resolve()
  return poll()
}

export function stopServiceStatusPoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  started = false
}
