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
import { SessionWatchdog } from './session-watchdog'
import type { WatchdogAdapter, WatchdogPublicState } from './session-watchdog'
import { stripAnsi } from './patterns'
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
// headroom while keeping the per-session buffer bounded.
const TAIL_MAX_LINES = 200

// Hard backstop on tail length, in characters, independent of the line-based
// cap above. appendTail's line cap splits on /\r?\n/ — output that only ever
// uses a lone \r (spinners/progress redraws with no \n) never produces a
// second "line" by that split, so the line cap never trips and the tail (and
// the cost of re-splitting it on every chunk) grows without bound. 64,000
// chars is generous headroom for 200 real lines while bounding the lone-\r
// case; the slice is O(1) relative to the capped size, keeping this backstop
// itself cheap regardless of how much lone-\r output has arrived.
const TAIL_MAX_CHARS = 64_000

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

export interface WatchdogSessionInfo {
  provider?: string
  ssh?: boolean
  shellOnly?: boolean
}

export interface WatchdogSettings {
  enabled?: boolean
  retryMessage?: string
  maxRetries?: number
  /** Silence window (ms). A session with no PTY output for this long is marked
   *  "silent". 0 disables. Absent = DEFAULT_SILENCE_WINDOW_MS. */
  silenceWindowMs?: number
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
  tail: string
  feedTimer: ReturnType<typeof setTimeout> | null
  /** now() of the last PTY chunk seen — reset on each feedData; drives silence. */
  lastDataAt: number
  /** Latched silence state (no output for the silence window). */
  silent: boolean
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
    const widened = TICK_INTERVAL_MS * (1 + Math.min(Math.max(stalls, 0), 12) * 0.5)
    return Math.min(MAX_TICK_INTERVAL_MS, Math.round(widened))
  }

  // Returns true when the silent state flipped, so the tick can fire one
  // onHealthChange for the whole pass.
  private evaluateSilence(entry: Entry): boolean {
    const window = this.silenceWindowMs()
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
      for (const [sessionId, entry] of this.entries) {
        try {
          entry.wd.tick()
        } catch (err) {
          logError(`[watchdog] tick() threw for ${sessionId}`, err)
        }
        if (this.evaluateSilence(entry)) silenceChanged = true
      }
      if (silenceChanged) { try { this.host.onHealthChange?.() } catch { /* host gone */ } }
      this.lastStalls = this.readStalls()
      this.currentTickMs = this.computeTickMs(this.lastStalls)
      if (this.entries.size > 0) {
        this.tickTimer = this.setTimer(run, this.currentTickMs)
        this.tickTimer.unref?.()
      }
    }
    this.lastStalls = this.readStalls()
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
    if (!isLocalClaudeSession(info)) return
    const settings = readWatchdogSettings()
    if (settings.enabled !== true) return // default OFF — feature is inert unless explicitly opted in

    // A restart can kill+respawn the PTY under the SAME sessionId (see the
    // restart-race comment on pty-manager.ts's onExit). If a watchdog is
    // already tracked for this sessionId, it is watching the OLD session's
    // stale state/config — tear it down before building a fresh one so it
    // can't send() into the just-respawned session. Never early-return on
    // has(): every gate above (isLocalClaudeSession, enabled) must still run
    // first so a since-disabled/ineligible session doesn't get re-armed.
    if (this.entries.has(sessionId)) this.stopWatchdog(sessionId)

    const adapter: WatchdogAdapter = {
      getTail: () => this.entries.get(sessionId)?.tail ?? '',
      isSessionAlive: () => this.host.isSessionAlive(sessionId),
      send: (text: string) => this.host.send(sessionId, text),
      now: () => this.now(),
      log: (level, msg) => {
        const line = `[watchdog:${sessionId}] ${msg}`
        if (level === 'error') logError(line)
        else if (level === 'warn') logWarn(line)
        else logInfo(line)
      },
      onStateChange: (state: WatchdogPublicState) => {
        this.eventsTotal++
        try { this.host.onHealthChange?.() } catch { /* host gone */ }
        const win = this.host.getWindow()
        if (!win || win.isDestroyed()) return
        try { win.webContents.send(IPC.WATCHDOG_STATE, state) } catch { /* destroyed */ }
      },
    }

    const wd = new SessionWatchdog(sessionId, adapter, {
      retryMessage: settings.retryMessage,
      maxRetries: settings.maxRetries,
    })
    this.entries.set(sessionId, { wd, tail: '', feedTimer: null, lastDataAt: this.now(), silent: false })
    if (this.startedAt === null) this.startedAt = this.now()
    this.ensureTickTimer()
    this.ensureHookSubscription()
    logInfo(`[watchdog] started for session ${sessionId}`)
  }

  stopWatchdog(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    if (entry.feedTimer) clearTimeout(entry.feedTimer)
    entry.wd.dispose()
    this.entries.delete(sessionId)
    this.maybeStopTimer()
  }

  disposeAll(): void {
    for (const sessionId of [...this.entries.keys()]) this.stopWatchdog(sessionId)
    if (this.hookUnsub) {
      this.hookUnsub()
      this.hookUnsub = null
    }
  }

  private appendTail(entry: Entry, data: string): void {
    const stripped = stripAnsi(data)
    const combined = entry.tail + stripped
    const lines = combined.split(/\r?\n/)
    const lineTrimmed = lines.length > TAIL_MAX_LINES ? lines.slice(lines.length - TAIL_MAX_LINES).join('\n') : combined
    // Char-length backstop: bounds lone-\r output (no \n, so the line-based
    // trim above never fires) and keeps entry.tail itself from growing
    // unbounded, which is what keeps the split() cost above bounded per call
    // rather than quadratic over the life of the session.
    entry.tail = lineTrimmed.length > TAIL_MAX_CHARS ? lineTrimmed.slice(lineTrimmed.length - TAIL_MAX_CHARS) : lineTrimmed
  }

  feedData(sessionId: string, data: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return // no watchdog running for this session (off, or not a local Claude session)
    // Silence detection (#235): each chunk resets the idle clock. Clear a
    // latched silent state immediately on the first byte after a silence.
    entry.lastDataAt = this.now()
    entry.silent = false
    this.appendTail(entry, data)
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
