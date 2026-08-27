// src/main/watchdog/watchdog-manager.ts
//
// Wiring layer for the session watchdog (#235). Owns the Map<sessionId,
// SessionWatchdog>, the per-session rolling tail buffer fed by PTY data, the
// ONE shared tick() interval, and the hooks-gateway StopFailure subscription.
//
// Deliberately decoupled from pty-manager.ts the same way
// services/pty-integrity-monitor.ts is: this module never imports
// pty-manager. The host (main/index.ts, where pty-manager and this module are
// both already wired) calls initWatchdogManager() once with the callbacks
// this manager needs (getWindow, isSessionAlive, send) — mirroring
// PtyIntegrityMonitorOptions.emit. pty-manager.ts only ever calls
// getWatchdogManager()?.<method>(), so there is no import cycle.
import type { BrowserWindow } from 'electron'
import { Terminal } from '@xterm/headless'
import { SessionWatchdog } from './session-watchdog'
import type { WatchdogAdapter, WatchdogPublicState } from './session-watchdog'
import { hasActiveMonitors } from './patterns'
import { getGateway } from '../hooks/index'
import { readConfig } from '../config-manager'
import { logInfo, logWarn, logError } from '../debug-logger'
import { IPC } from '../../shared/ipc-channels'
import type { HookEvent } from '../../shared/hook-types'
import { stallsLastMin as readMainLoopStalls } from '../services/loop-stall-monitor'
import { createInitialHealth } from '../../shared/service-health'
import type { DiagnosticsSnapshot, WatchdogMonitorSnapshot, WatchdogSessionMonitor } from '../../shared/service-health'

// Only a usage-limit-scale tail is needed for detection (mirrors
// session-watchdog's own USAGE_TAIL_LINES ceiling) — 200 lines is generous
// headroom while keeping the per-session read bounded.
const TAIL_MAX_LINES = 200

// The detection substrate is a RENDERED PANE, not an append-only log (#266
// BLOCKER-1). Claude Code's TUI (Ink) redraws IN PLACE with cursor moves and
// erases; stripping the ANSI and appending the text kept every partial redraw
// forever, so a stale "esc to interrupt" (or a long-cleared banner) pinned
// isWorking()/isRateLimited() true for the life of the window and the primary
// retry never fired in the common mid-turn case. Each watched session now owns
// a headless xterm Terminal (@xterm/headless — the same parser the visible
// terminal runs) fed the RAW bytes; getTail() reads what is actually ON
// SCREEN, plus genuinely scrolled-off lines up to the scrollback cap. Text a
// redraw overwrote never enters scrollback, so it is gone the moment the TUI
// erased it — exactly the pane semantics the detectors were written against.
const HEADLESS_SCROLLBACK = 200
// Viewport fallback before the first resize report arrives; noteResize keeps
// it matched to the real session so wrapping matches what the user sees.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
// Resize is synchronous main-thread work now (#266 review, F7): bound it so a
// pathological resize cannot spend seconds building an enormous grid. No real
// terminal approaches these.
const MAX_PANE_COLS = 1000
const MAX_PANE_ROWS = 1000

// The headless terminal PARSES the raw byte stream on the main thread now, and
// a CSI sequence with an enormous numeric parameter (chiefly REP, CSI Ps b —
// "repeat the last grapheme Ps times") is tens of seconds of synchronous work
// from ~15 bytes: a main-loop freeze from hostile session output (#266 review,
// F5). Clamp any 6+-digit run in a CSI parameter position to a still-generous
// ceiling before the terminal parses it. No legitimate sequence uses a
// parameter that large (screens are hundreds of cells, not hundreds of
// thousands), so rendering is unaffected; OSC/DCS payloads (which can carry
// long digit runs, e.g. a URL) are left alone — the anchor is `\x1b[` only.
// A CSI parameter above a few thousand is never legitimate (a screen is
// hundreds of cells; a REP fills at most a line), so every numeric parameter is
// capped by VALUE to a small ceiling. Capping the value (not trimming digits)
// makes the result DETERMINISTIC across chunk boundaries — a count dripped one
// byte at a time re-caps to the same ceiling every pass rather than leaving a
// residue — and keeps each clamped sequence trivial to render, which also
// bounds the chained amplification a stream of clamped REPs could cost (#266
// review, N3). Matches only the parameter run of a CSI (`\x1b[` then
// `[0-9;?]*`, stopping before the final byte); OSC/DCS payloads are never `[`.
const CSI_PARAMS = /(\x1b\[)([\d;?]*)/g
const CSI_VALUE_CEILING = 9999
const CSI_CEILING_STR = String(CSI_VALUE_CEILING)

// A CSI can STRADDLE a PTY chunk (the PTY delivers per-byte under load), and a
// per-chunk regex misses the split sequence that xterm then reassembles and
// runs — the F5 re-review proved `\x1b[2147` + `483647b` still froze main for
// 53 s. So a trailing INCOMPLETE CSI (an `\x1b[` with only parameter bytes
// after it, no final 0x40–0x7e yet) is held back and prepended to the next
// chunk, making the clamp see the whole sequence. The held part is itself
// clamped each pass, so a count dripped one digit per chunk is bounded before
// it ever completes, and the residual can never grow large. Capped so an
// abnormal run (a `;`-flood that is not a real CSI) is flushed rather than
// buffered forever.
const MAX_CSI_RESIDUAL = 64
/** A CSI final byte, per ECMA-48: 0x40–0x7e. */
function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e
}
/**
 * Index where a trailing INCOMPLETE escape begins, or -1 if the string does not
 * end mid-escape. Anchored on the last `\x1b`, because a CSI can be dripped one
 * byte at a time — a lone trailing `\x1b`, or `\x1b[` with only parameter bytes
 * after it, is unfinished and must be held so the clamp sees the assembled
 * sequence rather than xterm reassembling the split pieces itself (#266 review,
 * F5). A non-CSI escape (`\x1b]…`, `\x1bP…`, a two-byte `\x1bM`) is left to
 * complete on the next write: this module only clamps CSI parameters, and xterm
 * reassembles those natively.
 */
function trailingIncompleteCsiStart(s: string): number {
  const esc = s.lastIndexOf('\x1b')
  if (esc === -1) return -1
  // A lone trailing ESC — could begin any sequence, hold it.
  if (esc === s.length - 1) return esc
  // Only a CSI (`\x1b[`) is our concern; anything else we let through.
  if (s.charCodeAt(esc + 1) !== 0x5b /* [ */) return -1
  // `\x1b[` + params, complete only once a final byte (0x40–0x7e) appears after
  // the `[`. (The `[` itself is 0x5b, in that range, so the scan starts past it.)
  for (let i = esc + 2; i < s.length; i++) {
    if (isCsiFinal(s.charCodeAt(i))) return -1 // completed; nothing trails
  }
  return esc
}

export interface AnsiClampState {
  residual: string
}

/**
 * Clamp pathological CSI parameters across chunk boundaries. Returns the text
 * SAFE to write now; `state.residual` carries any trailing partial CSI to the
 * next call. Exported (with its state) so the regression test drives the exact
 * split the reviewer used.
 */
export function clampAnsiChunk(data: string, state: AnsiClampState): string {
  const combined = state.residual + data
  const clamped =
    combined.indexOf('\x1b[') === -1
      ? combined
      : combined.replace(CSI_PARAMS, (_m, pre: string, params: string) =>
          pre + params.replace(/\d+/g, (d) => (Number(d) > CSI_VALUE_CEILING ? CSI_CEILING_STR : d)))
  const cut = trailingIncompleteCsiStart(clamped)
  if (cut === -1) {
    state.residual = ''
    return clamped
  }
  // Hold the partial CSI back — unless it has grown past anything a real CSI
  // could be, in which case flush it (xterm tolerates a stray sequence; the
  // cost vector, a huge VALUE, is already digit-clamped above).
  if (clamped.length - cut > MAX_CSI_RESIDUAL) {
    state.residual = ''
    return clamped
  }
  state.residual = clamped.slice(cut)
  return clamped.slice(0, cut)
}

// The PTY fires onData per chunk (sometimes per byte under heavy output).
// Debounce feed() so a busy render doesn't run the detection regex ladder on
// every chunk — only once, ~250ms after the last chunk in a burst.
const FEED_DEBOUNCE_MS = 250

// One shared interval drives every active watchdog's tick(); it exists only
// while at least one watchdog is running (see ensureTickTimer/maybeStopTimer).
// This is the BASE cadence when the main loop is calm; the throttle (#311-style
// self-defense, ticket #235 follow-up) widens it under load — see computeTickMs.
const TICK_INTERVAL_MS = 5_000

// Hard ceiling on the widened tick cadence. Under sustained main-loop jank the
// watchdog backs its periodic work off toward this, so a busy main process is
// not further loaded by every session's tick() firing at the base rate. The
// countdown/retry checks lag by at most this much, which is acceptable — retries
// are scheduled minutes out, not seconds.
const MAX_TICK_INTERVAL_MS = 30_000

// A session that produces NO PTY output for this long is reported as "silent"
// (the provider stopped streaming). STATUS ONLY — silence never triggers a
// retry on its own (that stays gated on an actual detected banner). Configurable
// via settings.watchdog.silenceWindowMs; 0 disables silence detection.
const DEFAULT_SILENCE_WINDOW_MS = 120_000

// Activation grace (RC8): clicking/switching to a session makes its hidden
// terminal visible, which produces PTY OUTPUT that is a REDRAW, not work — the
// TUI answers the focus-report events xterm sends (Claude Code enables DECSET
// 1004; measured: a focus flip draws ~31 bytes) and ConPTY repaints the pane
// on a changed-geometry resize (~2.6 KB). Both used to count as the session
// "waking", so a click sometimes cleared the moon and sometimes didn't
// (geometry-dependent). For this window after such a trigger, output is
// EXCLUDED from silence bookkeeping: it neither clears a latched silence nor
// resets the idle clock (which would silently push an impending moon back).
// Genuine work resuming keeps streaming past the window and wakes normally,
// at most this much later. The pane still ingests every byte, so detection
// stays accurate.
export const ACTIVATION_GRACE_MS = 1_000

export interface WatchdogSessionInfo {
  provider?: string
  ssh?: boolean
  shellOnly?: boolean
  /** Ask Conductor sessions are ephemeral one-shot surfaces: a watchdog badge
   *  on one confuses more than it helps, so they never arm one (#266 MAJOR-5). */
  ask?: boolean
  /** Initial viewport for the rendered pane; kept live via noteResize. */
  cols?: number
  rows?: number
}

export interface WatchdogSettings {
  enabled?: boolean
  retryMessage?: string
  maxRetries?: number
  /** Silence window (ms). A session with no PTY output for this long is marked
   *  "silent". 0 disables. Absent = DEFAULT_SILENCE_WINDOW_MS. */
  silenceWindowMs?: number
  /** #419 F13 — the rest of the WatchdogConfig knobs, reachable from
   *  settings.json. Typed loosely on purpose: `resolveWatchdogConfig` is the
   *  one validator/sanitizer, and it fail-safes every field. The per-block
   *  `patterns` lists are stripped before threading (see
   *  threadedWatchdogConfig) and stay compiled-in. */
  marginSeconds?: number
  fallbackWaitHours?: number
  overload?: unknown
  safeguard?: unknown
}

/**
 * The settings keys threaded into a SessionWatchdog's config (#419 F13).
 * `resolveWatchdogConfig` remains the validator — this only decides WHAT is
 * reachable from settings.json. The overload/safeguard `patterns` lists are
 * deliberately NOT threaded: settings.json is renderer-writable, and the
 * patterns decide WHEN the watchdog types into the user's PTY — a hostile but
 * regex-valid pattern list could turn ordinary output into a retry storm.
 * They stay compiled-in (the #266 review counted that unreachability as a
 * security property; keep it).
 */
function threadedWatchdogConfig(settings: WatchdogSettings): Record<string, unknown> {
  const dropPatterns = (block: unknown): unknown => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return block
    const { patterns: _patterns, ...rest } = block as Record<string, unknown>
    return rest
  }
  return {
    retryMessage: settings.retryMessage,
    maxRetries: settings.maxRetries,
    marginSeconds: settings.marginSeconds,
    fallbackWaitHours: settings.fallbackWaitHours,
    ...(settings.overload !== undefined ? { overload: dropPatterns(settings.overload) } : {}),
    ...(settings.safeguard !== undefined ? { safeguard: dropPatterns(settings.safeguard) } : {}),
  }
}

export interface WatchdogHostOptions {
  getWindow: () => BrowserWindow | null
  isSessionAlive: (sessionId: string) => boolean
  /** Submit the retry into the session's PTY. The host wires this to the app's
   *  command-submit path — writePty(text + '\r'), the same write the command
   *  button and launch use — so the retry actually submits. The text is already
   *  sanitized to a single control-char-free line (config.ts), so the lone
   *  appended '\r' is the only submit and cannot be broken out of. */
  send: (sessionId: string, text: string) => void
  /** Main-loop stall count in the last minute — drives the tick throttle.
   *  Injectable for tests; defaults to the loop-stall-monitor singleton. */
  getStalls?: () => number
  /** Injectable clock/scheduler for deterministic tests. Default real timers. */
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
  /** Called when watchdog health changes (retry state or silence), so the host
   *  can refresh the services view. Optional; no-op when absent. */
  onHealthChange?: () => void
}

interface Entry {
  wd: SessionWatchdog
  /** The rendered pane (#266 BLOCKER-1): a headless terminal fed the raw PTY
   *  bytes, so getTail() reads the SCREEN, not an append-only strip log. */
  term: Terminal
  /** Carries a trailing partial CSI across chunks so the parameter clamp (F5)
   *  sees the whole sequence, not a split half. */
  ansiClamp: AnsiClampState
  feedTimer: ReturnType<typeof setTimeout> | null
  /** now() of the last PTY chunk seen — reset on each feedData; drives silence. */
  lastDataAt: number
  /** Latched silence state (no output for the silence window). */
  silent: boolean
  /** Until this now(), output is a click-redraw, not a wake (RC8). 0 = none. */
  graceUntil: number
}

/** Serialize the pane's last `maxLines` rendered lines (screen + genuinely
 *  scrolled-off scrollback), trailing blank rows trimmed — plus a DIM-BLANKED
 *  companion of the same lines for the send gate (#418).
 *
 *  `translateToString` discards attributes, and the gate needs exactly one:
 *  Claude Code renders the placeholder text in an EMPTY input dim ("Press up
 *  to edit queued messages", "Message @agent…"), so text-only reading cannot
 *  tell that `❯ <placeholder>` is the sendable empty prompt, not a draft —
 *  which made the gate defer forever whenever a queue/agent-view placeholder
 *  coexisted with a live rate limit. `nonDim` is the same rows with every dim
 *  cell blanked to a space, trimmed in LOCKSTEP with `text` so the two stay
 *  aligned line-for-line (canSendNow ignores the styled read if they are not). */
function readPanePair(term: Terminal, maxLines: number, withNonDim: boolean): { text: string; nonDim: string } {
  const buf = term.buffer.active
  const total = buf.length
  const start = Math.max(0, total - maxLines)
  const out: string[] = []
  const outNonDim: string[] = []
  const work = buf.getNullCell()
  for (let i = start; i < total; i++) {
    const line = buf.getLine(i)
    if (!line) {
      out.push('')
      outNonDim.push('')
      continue
    }
    out.push(line.translateToString(true))
    if (!withNonDim) {
      outNonDim.push('')
      continue
    }
    // Two passes: collect the visible cells, then blank dim cells and
    // SINGLE-CELL inverse runs. The focused empty input renders its cursor as
    // an inverse block OVER the placeholder's first character (claude.exe:
    // i(e[0]) + dim(e.slice(1))), so a dim-only mask left `❯ P` and the gate
    // still deferred forever (#418 review BLOCKER) — but ONLY a lone inverse
    // cell is the cursor. A multi-cell inverse run is content: a selected
    // range, or an atomic [Image #1] chip (claude.exe renders the whole chip
    // inverse when the cursor snaps to its edge), and blanking those flipped
    // a real draft into a sendable pane (round-2 MAJOR). An empty cell keeps
    // a SPACE, never '', so masked columns stay aligned with the raw row —
    // the gate's ink check is by column.
    const cells: Array<{ chars: string; dim: boolean; inverse: boolean }> = []
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, work)
      if (!cell) continue
      if (cell.getWidth() === 0) continue // the hidden tail cell of a wide glyph
      cells.push({ chars: cell.getChars(), dim: !!cell.isDim(), inverse: !!cell.isInverse() })
    }
    let masked = ''
    for (let c = 0; c < cells.length; c++) {
      const cur = cells[c]
      const loneInverse =
        cur.inverse && !(c > 0 && cells[c - 1].inverse) && !(c + 1 < cells.length && cells[c + 1].inverse)
      if (cur.dim || loneInverse) masked += ' '.repeat(Math.max(1, cur.chars.length))
      else masked += cur.chars.length > 0 ? cur.chars : ' '
    }
    outNonDim.push(masked.replace(/\s+$/, ''))
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') {
    out.pop()
    outNonDim.pop()
  }
  return { text: out.join('\n'), nonDim: outNonDim.join('\n') }
}

function readWatchdogSettings(): WatchdogSettings {
  try {
    return readConfig<{ watchdog?: WatchdogSettings }>('settings')?.watchdog ?? {}
  } catch {
    return {}
  }
}

// Gate: only a LOCAL Claude session gets a watchdog — never SSH, never Codex,
// never a bare shell (nothing to detect rate-limit/overload text in). The
// call site in pty-manager.ts only calls startWatchdog from the local-Claude
// branch already, but this re-checks so the manager is safe to call directly
// (and so the gating is unit-testable on its own).
function isLocalClaudeSession(info?: WatchdogSessionInfo): boolean {
  if (!info) return true
  if (info.ssh) return false
  if (info.shellOnly) return false
  if (info.ask) return false
  return (info.provider ?? 'claude') === 'claude'
}

// Best-effort mapping from a StopFailure hook payload to the two retryable
// error kinds SessionWatchdog.handleHookEvent() recognises. Claude Code's
// exact StopFailure payload shape is not documented in-repo (StopFailure was
// previously unregistered — see session-hooks-writer.ts), so this checks a
// few plausible field names defensively rather than assuming one; an
// unrecognised shape safely yields undefined (handleHookEvent then ignores
// the event, same as any non-retryable error kind).
function extractStopFailureError(payload: Record<string, unknown>): string | undefined {
  const raw = payload.error ?? payload.reason ?? payload.error_type ?? payload.errorType
  if (typeof raw !== 'string' || !raw) return undefined
  const lower = raw.toLowerCase()
  if (lower.includes('overload')) return 'overloaded'
  if (lower.includes('server_error') || lower.includes('server error') || /\b(500|502|503|529)\b/.test(lower)) {
    return 'server_error'
  }
  return undefined
}

export class WatchdogManager {
  private entries = new Map<string, Entry>()
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private hookUnsub: (() => void) | null = null

  // Injected deps (real timers / stall reader by default).
  private readStalls: () => number
  private now: () => number
  private setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  private clearTimer: (h: ReturnType<typeof setTimeout>) => void

  // Throttle + reporting state.
  private currentTickMs = TICK_INTERVAL_MS
  private lastStalls = 0
  private eventsTotal = 0
  private startedAt: number | null = null

  constructor(private host: WatchdogHostOptions) {
    this.readStalls = host.getStalls ?? (() => readMainLoopStalls())
    this.now = host.now ?? (() => Date.now())
    this.setTimer = host.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = host.clearTimer ?? ((h) => clearTimeout(h))
  }

  private silenceWindowMs(): number {
    const v = readWatchdogSettings().silenceWindowMs
    return typeof v === 'number' && v >= 0 ? v : DEFAULT_SILENCE_WINDOW_MS
  }

  // Widen the shared tick as main-loop stalls rise, so a busy main process is
  // not further loaded by every session ticking at the base rate. Bounded curve:
  // 0 stalls -> base (5s); each stall adds half the base; capped at 30s.
  private computeTickMs(stalls: number): number {
    // Guard a non-finite stall count (NaN/Infinity from a misbehaving reader):
    // Math.min/max would propagate NaN and produce a bad delay, so treat it as 0.
    const s = Number.isFinite(stalls) ? stalls : 0
    const widened = TICK_INTERVAL_MS * (1 + Math.min(Math.max(s, 0), 12) * 0.5)
    return Math.min(MAX_TICK_INTERVAL_MS, Math.round(widened))
  }

  // Returns true when the silent state flipped, so the tick can fire one
  // onHealthChange for the whole pass. The window is read ONCE per tick pass by
  // the caller (run) and passed in, so a busy tick does not re-read+parse the
  // settings file per session per tick (which would undercut the throttle).
  private evaluateSilence(entry: Entry, window: number): boolean {
    const next = window > 0 && (this.now() - entry.lastDataAt) > window
    if (next === entry.silent) return false
    entry.silent = next
    return true
  }

  private ensureHookSubscription(): void {
    if (this.hookUnsub) return
    const gw = getGateway()
    if (!gw) return
    this.hookUnsub = gw.subscribe((e: HookEvent) => {
      if (e.event !== 'StopFailure') return
      const entry = this.entries.get(e.sessionId)
      if (!entry) return
      try {
        entry.wd.handleHookEvent({ event: e.event, error: extractStopFailureError(e.payload) })
      } catch (err) {
        logError(`[watchdog] handleHookEvent threw for ${e.sessionId}`, err)
      }
    })
  }

  // Self-rescheduling tick (was a fixed setInterval): each pass reads the
  // main-loop stall count and picks the NEXT delay from computeTickMs, so the
  // cadence adapts to load. Reschedules only while at least one watchdog is
  // tracked; stopWatchdog/maybeStopTimer clears a pending timer at zero.
  private ensureTickTimer(): void {
    if (this.tickTimer) return
    const run = () => {
      this.tickTimer = null
      let silenceChanged = false
      // Read the silence window ONCE per pass (fix #4): evaluateSilence must not
      // re-read+parse the settings file per session per tick.
      const window = this.silenceWindowMs()
      for (const [sessionId, entry] of this.entries) {
        // Guard the WHOLE per-entry body (tick + silence) so one session's throw
        // cannot kill the shared tick for every other session (fix #5).
        try {
          entry.wd.tick()
          if (this.evaluateSilence(entry, window)) silenceChanged = true
        } catch (err) {
          logError(`[watchdog] tick() threw for ${sessionId}`, err)
        }
      }
      if (silenceChanged) { try { this.host.onHealthChange?.() } catch { /* host gone */ } }
      // A throwing stall reader must not kill the tick either (fix #5).
      try { this.lastStalls = this.readStalls() } catch { /* keep the last value */ }
      this.currentTickMs = this.computeTickMs(this.lastStalls)
      if (this.entries.size > 0) {
        this.tickTimer = this.setTimer(run, this.currentTickMs)
        this.tickTimer.unref?.()
      }
    }
    try { this.lastStalls = this.readStalls() } catch { /* keep the last value */ }
    this.currentTickMs = this.computeTickMs(this.lastStalls)
    this.tickTimer = this.setTimer(run, this.currentTickMs)
    this.tickTimer.unref?.()
  }

  private maybeStopTimer(): void {
    if (this.entries.size === 0 && this.tickTimer) {
      this.clearTimer(this.tickTimer)
      this.tickTimer = null
    }
  }

  startWatchdog(sessionId: string, info?: WatchdogSessionInfo): void {
    // A restart reuses the sessionId. Tear down any watchdog tracked for it
    // FIRST — BEFORE the eligibility/enabled gates — so a restart into an
    // ineligible session type (Codex / SSH / shell-only) or with the feature
    // since disabled cannot leave the OLD watcher armed and able to send() into
    // the just-respawned PTY (adversarial FINDING 1, defense-in-depth alongside
    // pty-manager's cleanupSessionResources teardown). The prior code ran the
    // gates first, so a disabled/ineligible restart returned early and LEFT the
    // stale watcher in place.
    if (this.entries.has(sessionId)) this.stopWatchdog(sessionId)

    if (!isLocalClaudeSession(info)) return
    const settings = readWatchdogSettings()
    if (settings.enabled !== true) return // default OFF — feature is inert unless explicitly opted in

    const adapter: WatchdogAdapter = {
      getTail: () => {
        const e = this.entries.get(sessionId)
        // No masked build here: getTail runs on every debounced feed, and the
        // cell walk costs ~2.5x translateToString. The styled read happens
        // only at send-gate time below.
        return e ? readPanePair(e.term, TAIL_MAX_LINES, false).text : ''
      },
      getTailNonDim: () => {
        const e = this.entries.get(sessionId)
        return e ? readPanePair(e.term, TAIL_MAX_LINES, true).nonDim : ''
      },
      isSessionAlive: () => this.host.isSessionAlive(sessionId),
      send: (text: string) => this.host.send(sessionId, text),
      now: () => this.now(),
      log: (level, msg) => {
        const line = `[watchdog:${sessionId}] ${msg}`
        if (level === 'error') logError(line)
        else if (level === 'warn') logWarn(line)
        else logInfo(line)
      },
      onStateChange: (state: WatchdogPublicState) => this.pushState(state),
    }

    const wd = new SessionWatchdog(sessionId, adapter, threadedWatchdogConfig(settings))
    const term = new Terminal({
      cols: info?.cols ?? DEFAULT_COLS,
      rows: info?.rows ?? DEFAULT_ROWS,
      scrollback: HEADLESS_SCROLLBACK,
      allowProposedApi: true,
    })
    this.entries.set(sessionId, { wd, term, ansiClamp: { residual: '' }, feedTimer: null, lastDataAt: this.now(), silent: false, graceUntil: 0 })
    if (this.startedAt === null) this.startedAt = this.now()
    this.ensureTickTimer()
    this.ensureHookSubscription()
    // Push the fresh 'monitoring' state immediately (#266 MAJOR-4): a restart
    // reuses the sessionId, and without this the renderer kept painting the
    // PREVIOUS run's give-up badge until the new run's first state change.
    adapter.onStateChange(wd.getState())
    logInfo(`[watchdog] started for session ${sessionId}`)
  }

  /** Keep the headless pane's viewport matched to the real session's, so line
   *  wrapping (and therefore every line-anchored detector) matches what the
   *  user actually sees. No-op for untracked sessions. */
  noteResize(sessionId: string, cols: number, rows: number): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    // Bounded BOTH ways (#266 review, F7): a resize is synchronous work in the
    // main process now, and a 60000x60000 resize is tens of seconds of it. No
    // real terminal exceeds these, so clamping never loses fidelity.
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    if (cols < 2 || rows < 2 || cols > MAX_PANE_COLS || rows > MAX_PANE_ROWS) return
    try {
      entry.term.resize(cols, rows)
    } catch { /* a mid-write resize throw must not kill the PTY data path */ }
    // A resize makes ConPTY repaint the pane — redraw output, not the session
    // waking (RC8). Arm the grace so the repaint is excluded from silence
    // bookkeeping. This covers both the click-activation resize (hidden
    // terminal shown at a changed geometry) and a window/sidebar resize over a
    // sleeping session.
    entry.graceUntil = this.now() + ACTIVATION_GRACE_MS
  }

  /** Arm the activation grace for a session (RC8): the next
   *  ACTIVATION_GRACE_MS of output is a click/focus redraw, not a wake. The
   *  host calls this when it sees a redraw trigger that is not a resize —
   *  chiefly the DECSET-1004 focus-report chunks (\x1b[I / \x1b[O) xterm
   *  writes into the PTY when a session pane gains or loses focus. No-op for
   *  untracked sessions. */
  noteRedrawTrigger(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.graceUntil = this.now() + ACTIVATION_GRACE_MS
  }

  /** Publish one watchdog state to the renderer (and refresh the services
   *  view). The single push path, so teardown can clear a stranded badge the
   *  same way a live change updates one (#266 review, F9). */
  private pushState(state: WatchdogPublicState): void {
    this.eventsTotal++
    try { this.host.onHealthChange?.() } catch { /* host gone */ }
    const win = this.host.getWindow()
    if (!win || win.isDestroyed()) return
    try { win.webContents.send(IPC.WATCHDOG_STATE, state) } catch { /* destroyed */ }
  }

  /** The neutral state a torn-down session publishes: 'monitoring', not
   *  waiting, not given up — which the WatchdogBadge renders as nothing. */
  private clearedState(sessionId: string): WatchdogPublicState {
    return {
      sessionId,
      status: 'monitoring',
      attempts: 0,
      overloadAttempts: 0,
      safeguardAttempts: 0,
      waitUntil: null,
      gaveUp: false,
      lastAction: 'watchdog stopped',
      updatedAt: this.now(),
    }
  }

  /** Re-read settings after a save (#266 MAJOR-2): unticking the feature must
   *  tear down RUNNING watchdogs, not only stop future ones arming. */
  applySettings(): void {
    if (readWatchdogSettings().enabled === true) return
    if (this.entries.size === 0) return
    logInfo('[watchdog] disabled in settings — tearing down running watchdogs')
    this.disposeAll()
  }

  stopWatchdog(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    if (entry.feedTimer) clearTimeout(entry.feedTimer)
    entry.wd.dispose()
    try { entry.term.dispose() } catch { /* already disposed */ }
    this.entries.delete(sessionId)
    // Clear any badge the torn-down watcher left on the session card (#266
    // review, F9): unticking the feature, the services-panel Restart, and a
    // natural session exit all reach here, and none of them updated the UI.
    this.pushState(this.clearedState(sessionId))
    this.maybeStopTimer()
  }

  disposeAll(): void {
    for (const sessionId of [...this.entries.keys()]) this.stopWatchdog(sessionId)
    if (this.hookUnsub) {
      this.hookUnsub()
      this.hookUnsub = null
    }
  }

  feedData(sessionId: string, data: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return // no watchdog running for this session (off, or not a local Claude session)
    // Silence detection (#235): each chunk resets the idle clock. Clear a
    // latched silent state immediately on the first byte after a silence —
    // and PUSH the flip: the sleep indicator rides diagnostics pushes, and
    // without this the wake only reached the renderer on the next unrelated
    // heartbeat (with hooks and logging both off, potentially much later).
    //
    // EXCEPT inside the activation grace (RC8): output arriving within
    // ACTIVATION_GRACE_MS of a redraw trigger (focus-report write, resize) is
    // the TUI repainting for a click, not work resuming. It must neither clear
    // a latched silence (the click-wake bug) nor reset the idle clock (a click
    // on a not-yet-silent session would silently push its moon back a full
    // window). Genuine work keeps streaming past the grace and wakes then.
    const now = this.now()
    if (now >= entry.graceUntil) {
      entry.lastDataAt = now
      if (entry.silent) {
        entry.silent = false
        try { this.host.onHealthChange?.() } catch { /* host gone */ }
      }
    }
    // RAW bytes into the rendered pane — the terminal's parser is the tail
    // discipline now (#266 BLOCKER-1); no stripping, no manual line caps. Only
    // pathological CSI parameters are clamped first (F5), across chunk
    // boundaries via the per-entry residual, so hostile output cannot turn a
    // ~15-byte sequence (split or whole) into a main-thread freeze.
    try {
      entry.term.write(clampAnsiChunk(data, entry.ansiClamp))
    } catch (err) {
      logError(`[watchdog] headless write threw for ${sessionId}`, err)
    }
    if (entry.feedTimer) return // a feed is already scheduled for this burst
    entry.feedTimer = setTimeout(() => {
      entry.feedTimer = null
      try {
        entry.wd.feed()
      } catch (err) {
        logError(`[watchdog] feed() threw for ${sessionId}`, err)
      }
    }, FEED_DEBOUNCE_MS)
  }

  getStates(): WatchdogPublicState[] {
    return [...this.entries.values()].map((e) => e.wd.getState())
  }

  isActive(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  /** Does this entry's rendered pane advertise active monitors in its mode
   *  footer? Reads the same TAIL_MAX_LINES window getTail uses — readPanePair
   *  counts raw buffer rows (blank rows below sparse content consume a small
   *  window) and trims trailing blanks, and hasActiveMonitors then scopes its
   *  scan to the last 15 rendered lines, so the anchor stays tight. Guarded:
   *  a pane-read throw must not kill a health push. */
  private paneHasMonitors(e: Entry): boolean {
    try {
      return hasActiveMonitors(readPanePair(e.term, TAIL_MAX_LINES, false).text)
    } catch {
      return false
    }
  }

  /** Per-session monitor state + current throttle, for the services view. */
  getMonitorSnapshot(): WatchdogMonitorSnapshot {
    const now = this.now()
    const sessions: WatchdogSessionMonitor[] = [...this.entries.entries()].map(([sessionId, e]) => {
      const st = e.wd.getState()
      return {
        sessionId,
        status: st.status,
        gaveUp: st.gaveUp,
        waitUntil: st.waitUntil,
        silent: e.silent,
        idleMs: Math.max(0, now - e.lastDataAt),
        // Monitor-aware sleep (RC8): a session with active monitors is quiet
        // between triggers by design, so the moon skips it. Read only for
        // SILENT sessions — the only ones the moon consults. While silent the
        // pane changes only on graced click-redraw output, so reading it per
        // snapshot (not per feed burst) is both cheap and current.
        hasMonitors: e.silent ? this.paneHasMonitors(e) : false,
      }
    })
    return {
      activeSessions: sessions.length,
      waitingSessions: sessions.filter((s) => s.status !== 'monitoring' && !s.gaveUp).length,
      silentSessions: sessions.filter((s) => s.silent).length,
      throttle: { stallsLastMin: this.lastStalls, tickMs: this.currentTickMs },
      sessions,
    }
  }

  /** ServiceHealth snapshot so the watchdog appears in the services view merge,
   *  modelled on the logging supervisor's getDiagnosticsSnapshot(). */
  getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    const now = this.now()
    const mon = this.getMonitorSnapshot()
    const health = createInitialHealth('watchdog', 'Watchdog')
    health.state = this.entries.size > 0 ? 'listening' : 'stopped'
    health.startedAt = this.startedAt
    health.inFlight = mon.waitingSessions
    health.eventsTotal = this.eventsTotal
    health.mainLoopStallsLastMin = this.lastStalls
    health.lastHeartbeatAt = now
    return { capturedAt: now, services: [health], log: [] }
  }

  /** Restart hook for the services view. Per-session watchdogs re-arm at the
   *  next PTY spawn, so a manual restart tears down current watchers under the
   *  current settings rather than resurrecting mid-session give-up latches. */
  manualRestart(serviceId: string): { ok: boolean; reason?: string } {
    if (serviceId !== 'watchdog') return { ok: false, reason: 'unknown-service' }
    this.disposeAll()
    return { ok: true }
  }
}

// Module singleton, same shape as services/pty-integrity-monitor.ts's
// setPtyIntegrityMonitor/getPtyIntegrityMonitor — lets pty-manager (a
// separate module this file never imports) call through a getter without an
// import cycle.
let _manager: WatchdogManager | null = null

export function initWatchdogManager(opts: WatchdogHostOptions): WatchdogManager {
  _manager = new WatchdogManager(opts)
  return _manager
}

export function getWatchdogManager(): WatchdogManager | null {
  return _manager
}

// Test seam: unit tests construct/replace the singleton directly.
export function setWatchdogManagerForTest(m: WatchdogManager | null): void {
  _manager = m
}
