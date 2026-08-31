/**
 * Statusline Watcher (generic dispatcher)
 *
 * After the P0.7 lift this module is provider-agnostic plumbing:
 *
 * 1. The Claude statusline bridge script (deployed by
 *    providers/claude/statusline.ts → deployClaudeStatuslineScript) writes
 *    one JSON file per session to <resourcesDir>/status/<sessionId>.json.
 * 2. startStatuslineWatcher() runs an fs.watch + poll-fallback over that
 *    directory and on each change:
 *      a. sends `statusline:update` to the renderer
 *      b. fans out to per-session subscribers registered via the Claude
 *         provider's ingestSessionTelemetry()
 *    (Tokenomics no longer ingests here — the indexing worker reads raw
 *    transcripts on its own timer/fs-watch.)
 *
 * Since the harmonise-remote unification the PRIMARY delivery for every
 * session type is an HTTP POST to the conductor MCP server's /status endpoint
 * (local bridge → loopback; SSH shim → reverse tunnel), which lands here via
 * dispatchSSHStatuslineUpdate() and the same fan-out pipeline. The file watch
 * below is the LOCAL fallback (MCP server unbound, stale per-session
 * settings); the OSC sentinel path (pty-manager.ts:extractSshOscSentinels →
 * dispatchSSHStatuslineUpdate) is the SSH fallback for tunnel-less sessions.
 *
 * Provider-specific deploy/configure logic lives in providers/claude/statusline.ts.
 * The legacy deployStatuslineScript() / configureClaudeSettings() symbols are
 * re-exported below for backward compatibility, but new code should go through
 * the provider: getProvider('claude').deployStatuslineScript?.(resourcesDir).
 */
import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

import { getResourcesDirectory } from './ipc/setup-handlers'
import { decorateStatuslineWithColour } from './account-color'
import { notifyClaudeTelemetry } from './providers/claude/telemetry'
import { sentinelObserve } from './sentinel/index'
import { isBackgroundContext } from './background-context'
import { logWarn } from './debug-logger'
import { sanitiseTranscriptPath } from './logging/transcript-discovery'

// Re-export from shared types for backward compatibility
export type { StatuslineData } from '../shared/types'
import type { StatuslineData } from '../shared/types'

// Backwards-compatible re-exports of the lifted Claude-specific helpers.
// New callers should use getProvider('claude').deployStatuslineScript?.(...).
export { deployClaudeStatuslineScript as deployStatuslineScript, healGlobalStatusline } from './providers/claude/statusline'

// Lazy-initialized: can't call getResourcesDirectory() at module load time
let STATUS_DIR: string | null = null
function getStatusDir(): string {
  if (!STATUS_DIR) {
    STATUS_DIR = path.join(getResourcesDirectory(), 'status')
  }
  return STATUS_DIR
}

// SSH statusline dispatch — receives parsed status data from pty-manager's
// OSC sentinel parser and feeds it through the same pipeline as the file watcher.
let sshDispatchWindow: (() => BrowserWindow | null) | null = null

// Logs v2 (Task 8): the transcript binder sink. The statusline JSON carries
// Claude Code's live `transcript_path` (continuous, exact discovery source);
// every fan-out forwards it here so the binder can tail the file. Registered at
// boot via setTranscriptPathSink(); null until then (and in unit tests).
let transcriptPathSink: ((sessionId: string, path: string) => void) | null = null

/** Register the transcript binder's notify sink (called once at boot). */
export function setTranscriptPathSink(sink: (sessionId: string, path: string) => void): void {
  transcriptPathSink = sink
}

/**
 * Common fan-out for any parsed StatuslineData payload — used by both the
 * file watcher and the SSH OSC sentinel dispatch path. Sends to the renderer
 * and per-session telemetry subscribers.
 *
 * Tokenomics no longer ingests from the statusline tick (the old
 * tokenomics-manager.handleStatuslineUpdate ran a full ~37k-session aggregate
 * rebuild on EVERY tick — the ~30s UI freeze). The tokenomics worker now
 * indexes from raw transcripts on its own fs-watch/timer.
 */
function fanOutStatusline(data: StatuslineData, getWindow: (() => BrowserWindow | null) | null): void {
  // Copilot review on PR #31 (p9.17): decorate with accountColour HERE,
  // at the renderer-send site, so the ContextBar sees accountColour. Decorate
  // once and forward the enriched object to every consumer.
  const decorated = decorateStatuslineWithColour(data)
  // While a subagent / dynamic-workflow agent runs under this session, CC's
  // statusline reports the AGENT's model + effort. Strip those two fields from
  // the DISPLAY payload so the strip's pills stay pinned to the main window.
  // Everything else (context %, cost, tokens, rate limits, transcript path)
  // is session- or account-level and still flows. Sentinel (below) and the
  // transcript binder read the RAW `data`, so they are unaffected.
  let forDisplay = decorated
  if (isBackgroundContext(data.sessionId, data.transcriptPath)) {
    forDisplay = { ...decorated }
    delete forDisplay.model
    delete forDisplay.modelId
    delete forDisplay.effortLevel
  }
  if (getWindow) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('statusline:update', forDisplay)
    }
  }
  notifyClaudeTelemetry(forDisplay)
  // Logs v2 (Task 8): forward the live transcript path to the binder (continuous,
  // exact discovery source). Guarded — the sink may not be registered yet (and
  // isn't in unit tests). A throw here must not break the statusline pipeline.
  if (data.transcriptPath && data.sessionId && transcriptPathSink) {
    try { transcriptPathSink(data.sessionId, data.transcriptPath) } catch { /* sink must not break fan-out */ }
  }
  // Sentinel Trigger A: observe the raw model id (modelId preferred; fall back to
  // model which may be a display name — the resolver handles both). Safe before
  // initSentinel: sentinelObserve is a no-op when the observer is not yet set.
  const rawModel = data.modelId ?? data.model
  if (typeof rawModel === 'string' && rawModel) {
    try { sentinelObserve({ kind: 'model', value: rawModel, source: 'statusline' }) } catch { /* must not break fan-out */ }
  }
}

/**
 * Dispatch a statusline payload that arrived as a STRING (not via the file
 * watcher) to the renderer. Two callers: the conductor MCP server's /status
 * ingest (the primary channel for BOTH local and SSH sessions since the
 * harmonise-remote unification — the name predates that) and pty-manager's
 * OSC sentinel parser (SSH fallback). Every payload passes the same shape
 * filter regardless of origin.
 */
export function dispatchSSHStatuslineUpdate(json: string): void {
  if (!sshDispatchWindow) return
  try {
    const parsed: unknown = JSON.parse(json)
    const data = sanitiseSentinelPayload(parsed)
    if (!data) return
    fanOutStatusline(data, sshDispatchWindow)
  } catch { /* ignore malformed sentinel payloads */ }
}

/**
 * Length cap for every free string a status payload can carry.
 *
 * Adversarial review (ADR-009): the sanitiser bounded `sessionId` and nothing
 * else, so every other string -- model name, reset timestamps, account label --
 * was copied at whatever length the sender chose, on every tick, straight into
 * the renderer. 256 is generous for every real field (Claude's longest model
 * display name is well under 40) and the same bound `sessionId` already used.
 */
const STATUS_STRING_MAX = 256

/** Cap on `usageBuckets` entries. Real payloads carry 2-6 (5h + per-model weekly). */
const STATUS_BUCKETS_MAX = 32

/**
 * Maximum length of a remote account label, and the display charset it must
 * match. An email address and nothing else.
 *
 * THE single validator for this field, shared by both delivery paths (ADR-009):
 * pty-manager's `parseSetupAccountSentinel` (the setup-sentinel path, which has
 * gated it since item 10) and `sanitiseSentinelPayload` below (the /status
 * ingest, which did not). Both are fed by a REMOTE host that chooses the value,
 * both surface it as a label next to the session, and the renderer prefers the
 * /status value where both exist -- so a validator on only one of them was a
 * validator on neither. It is never interpreted, never a credential, never an
 * auth key; the gate is a display gate, so anything that is not plainly an email
 * is dropped rather than repaired.
 */
export const REMOTE_ACCOUNT_MAX = 254
export const REMOTE_ACCOUNT_DISPLAY_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

/** Returns the label when it passes the display gate, `undefined` otherwise. */
export function sanitiseRemoteAccountEmail(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > REMOTE_ACCOUNT_MAX) return undefined
  return REMOTE_ACCOUNT_DISPLAY_RE.test(v) ? v : undefined
}

/**
 * Shape-check an OSC sentinel payload before it is fanned out.
 *
 * This payload is lifted verbatim out of an SSH PTY byte stream, so it is
 * REMOTE-CONTROLLED: the host you connected to decides its contents, and it
 * reached `JSON.parse` with no validation at all. Everything downstream --
 * the renderer, the telemetry fan-out, the transcript binder -- was trusting a
 * `StatuslineData` type assertion over a value the type system never checked.
 *
 * Deliberately a shape filter, not a strict schema. Rejecting the whole payload
 * on one unexpected field would break the statusline against any CLI version
 * whose fields we do not yet know about, which is a reliability regression paid
 * for no security gain. Instead: require an object with a usable `sessionId`,
 * then keep only fields whose runtime type matches the declared one and drop
 * the rest. A hostile host can still send *valid* values -- that is inherent to
 * a statusline -- but it can no longer smuggle a value of the wrong TYPE into
 * code that assumed otherwise.
 */
function sanitiseSentinelPayload(v: unknown): StatuslineData | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const src = v as Record<string, unknown>

  // sessionId is the routing key -- without a usable one there is nothing to
  // fan out to. Bounded because it is used to build log lines and lookups.
  const sessionId = src.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > STATUS_STRING_MAX) return null

  const out: Record<string, unknown> = { sessionId }
  for (const [key, val] of Object.entries(src)) {
    if (key === 'sessionId') continue
    // The remote account label. The OSC/setup-sentinel path has always run this
    // through a strict display validator (parseSetupAccountSentinel,
    // pty-manager.ts); this path copied it verbatim -- any length, any codepoint
    // -- and the renderer reads `accountEmail || sshRemoteAccount`, so the
    // UNVALIDATED value won wherever both existed. A hostile remote controls this
    // field. One validator now gates both deliveries; anything that fails is
    // DROPPED, so the render sites fall back to the sentinel-validated snapshot.
    if (key === 'accountEmail') {
      const clean = sanitiseRemoteAccountEmail(val)
      if (clean !== undefined) out[key] = clean
      continue
    }
    // Per-model usage buckets: an array of small label/percent records the
    // renderer draws directly. Bound the array AND the strings inside it -- the
    // generic object passthrough below would otherwise let a hostile remote hand
    // the renderer thousands of buckets carrying megabyte-long labels.
    if (key === 'usageBuckets') {
      const clean = sanitiseUsageBuckets(val)
      if (clean !== null) out[key] = clean
      continue
    }
    // transcriptPath goes to the SAME transcript binder the hooks gateway feeds,
    // and the gateway shape-filters it (#180). This side only type-checked it, so
    // the two sources disagreed about the same field: any string, any length, any
    // characters. Use the one filter, so a third source added later cannot pick
    // the weaker of two.
    if (key === 'transcriptPath') {
      const clean = sanitiseTranscriptPath(val)
      if (clean !== null) out[key] = clean
      continue
    }
    const t = typeof val
    // Scalars are copied when they are finite/real; objects are passed through
    // for the nested shapes (rateLimitExtra) that the renderer already treats
    // defensively. Strings are LENGTH-BOUNDED: every one of them is a label the
    // renderer puts on screen, and an unbounded copy let a hostile remote push
    // an arbitrarily long value through the fan-out on every tick. Over-long
    // values are dropped, not truncated -- a half-string is not a better label
    // than none, and dropping keeps the previous good value on screen.
    if (t === 'string') { if ((val as string).length <= STATUS_STRING_MAX) out[key] = val }
    else if (t === 'boolean' || t === 'object') out[key] = val
    else if (t === 'number' && Number.isFinite(val as number)) out[key] = val
  }
  return out as unknown as StatuslineData
}

/**
 * Bound the per-model usage-bucket array: at most STATUS_BUCKETS_MAX entries,
 * each an object whose string fields are length-capped the same way every other
 * displayed string is. Non-object entries are dropped. Returns null when the
 * value is not an array at all (the key is then omitted entirely).
 */
function sanitiseUsageBuckets(v: unknown): unknown[] | null {
  if (!Array.isArray(v)) return null
  const out: unknown[] = []
  for (const entry of v.slice(0, STATUS_BUCKETS_MAX)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const clean: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof val === 'string') { if (val.length <= STATUS_STRING_MAX) clean[k] = val }
      else if (typeof val === 'number') { if (Number.isFinite(val)) clean[k] = val }
      else if (typeof val === 'boolean') clean[k] = val
    }
    out.push(clean)
  }
  return out
}

/**
 * Watch the status directory for updates and send to the renderer.
 * Uses fs.watch for instant local notifications, plus a polling fallback
 * for remote/SMB writes that don't trigger ReadDirectoryChangesW on Windows.
 */
export function startStatuslineWatcher(getWindow: () => BrowserWindow | null): () => void {
  // Register the same window getter for SSH dispatch so OSC sentinels feed the renderer
  sshDispatchWindow = getWindow

  const statusDir = getStatusDir()
  if (!fs.existsSync(statusDir)) {
    fs.mkdirSync(statusDir, { recursive: true })
  }

  // Track last-seen mtime per file to avoid redundant sends
  const lastMtime = new Map<string, number>()

  // Async so the per-tick stat + read never block the main thread. The
  // statusline bridge rewrites these files frequently (≈1-3/s per session) and
  // fs.watch fired this synchronously on every write -- a sync readFileSync +
  // JSON.parse on the hot path, multiplied by N sessions. The mtime guard stays
  // race-safe: the check+set sits in one synchronous block immediately after the
  // awaited stat (no await between), so two concurrent calls for the same file
  // can't both pass the guard -- the first sets the mtime, the second is deduped.
  async function processFile(filename: string): Promise<void> {
    const win = getWindow()
    if (!win || win.isDestroyed()) return

    const filePath = path.join(statusDir, filename)
    try {
      const mtime = (await fs.promises.stat(filePath)).mtimeMs
      if (lastMtime.get(filename) === mtime) return
      lastMtime.set(filename, mtime)

      const content = await fs.promises.readFile(filePath, 'utf-8')
      const data: StatuslineData = JSON.parse(content)
      fanOutStatusline(data, getWindow)
    } catch { /* ignore read errors during writes */ }
  }

  // Boot-time reaper: drop status files from sessions that ended long ago so the
  // poll fan-out (a readdir + per-file stat every 5s) and the lastMtime map can't
  // grow unbounded for the life of the install. Session ids are unique per run and
  // the resources dir survives reinstalls, so without this they accumulate forever.
  sweepStaleStatusFiles()

  // fs.watch: instant for local writes. Must attach an 'error' listener -- without
  // one, an FSWatcher 'error' (EPERM/UNKNOWN on a network-drive disconnect, the dir
  // being deleted, or a ReadDirectoryChangesW failure) is an uncaughtException, and
  // the global handler re-throws everything except EPIPE/EIO -> whole-app crash with
  // all live PTYs lost. On error we close the broken watcher and lean on the 5s poll
  // fallback below, which already covers exactly this (remote/SMB/missed-event) case.
  let watcher: fs.FSWatcher | null = null
  function startWatcher(): void {
    try {
      const w = fs.watch(statusDir, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return
        void processFile(filename)
      })
      w.on('error', (err) => {
        logWarn('[statusline-watcher] fs.watch error; falling back to polling:', err)
        try { w.close() } catch { /* already closed */ }
        if (watcher === w) watcher = null
      })
      watcher = w
    } catch (err) {
      // fs.watch itself can throw synchronously (e.g. dir vanished). Poll covers it.
      logWarn('[statusline-watcher] fs.watch could not start; relying on polling:', err)
      watcher = null
    }
  }
  startWatcher()

  // Polling fallback: catches remote/SMB writes that fs.watch misses, AND is the
  // sole notification path after a watcher error closes the FSWatcher. Local writes
  // are caught instantly by fs.watch above, so this only needs to be a slow safety
  // net -- 5s (was 3s) cuts the periodic readdir + stat fan-out.
  const POLL_INTERVAL = 5000
  const pollTimer = setInterval(() => {
    void (async () => {
      try {
        const present = new Set<string>()
        const files = (await fs.promises.readdir(statusDir)).filter(f => f.endsWith('.json'))
        for (const f of files) present.add(f)
        await Promise.all(files.map(f => processFile(f)))
        // Evict lastMtime entries for files that have gone (cleaned-up sessions),
        // so the map tracks only live status files rather than every file ever seen.
        for (const known of lastMtime.keys()) if (!present.has(known)) lastMtime.delete(known)
      } catch { /* ignore */ }
    })()
  }, POLL_INTERVAL)

  return () => {
    if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = null }
    clearInterval(pollTimer)
  }
}

/**
 * Clean up the status file for a given session. Intended to be wired into the
 * per-session PTY exit teardown so the poll fan-out doesn't grow for the life of
 * the install. Safe to call when the file is already gone.
 */
export function cleanupStatusFile(sessionId: string): void {
  const filePath = path.join(getStatusDir(), `${sessionId}.json`)
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}

const STALE_STATUS_MS = 1000 * 60 * 60 * 24 * 3 // 3 days

/**
 * Boot-time reaper: unlink status files whose mtime is older than `maxAgeMs`.
 * Session ids are unique per run and the resources dir survives reinstalls, so
 * without this each session ever run leaves a status JSON behind forever and the
 * 5s poll degrades into a readdir + thousands of stats. Returns the count removed.
 */
export function sweepStaleStatusFiles(maxAgeMs: number = STALE_STATUS_MS): number {
  const dir = getStatusDir()
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch { return 0 } // dir missing -> nothing to sweep
  for (const f of files) {
    const filePath = path.join(dir, f)
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) { fs.unlinkSync(filePath); removed++ }
    } catch { /* concurrent write/remove; ignore */ }
  }
  return removed
}
