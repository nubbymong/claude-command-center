// Policy derived from claude-auto-retry (https://github.com/cheapestinference/claude-auto-retry), MIT License.
//
// Per-session watchdog state machine. Adapted from upstream's tmux-polling
// monitor loop (src/monitor.js) to be event-driven on PTY data instead of a
// tmux `capture-pane` poll, with all I/O (tail read, liveness, send, clock,
// logging, state publication) routed through an injected WatchdogAdapter so
// this class has no direct PTY/session dependency and is fully unit-testable.
//
// Detection (rate limit / overload / safeguard, plus recovery/clearing) reacts
// to new PTY content via feed(). Firing a retry reacts to wall-clock expiry via
// tick(), which the wiring layer drives on its own timer — this class never
// creates a timer itself, and every timestamp flows through adapter.now().

import {
  isRateLimited,
  findRateLimitMessage,
  detectOverload,
  detectSafeguard,
  isWorking,
  isInternalRetry,
  resumedAfterLimit,
  canSendNow,
} from './patterns'
import { parseResetTime, calculateWaitMs } from './time-parser'
import { resolveWatchdogConfig } from './config'
import type { WatchdogConfig } from './config'

// --- Contract adjustments vs. the nominal sibling-module contracts this class
// was designed against (both sibling modules landed with slightly different,
// more capable signatures than the stub contract; adapting call sites here,
// never the sibling files, per the task brief):
//   - isRateLimited/resumedAfterLimit take positional (text, customPatterns[],
//     tailLines) args, not an options object.
//   - detectOverload/detectSafeguard take (text, patterns[]) and do nothing
//     (always false) without a non-empty patterns array — there is no built-in
//     default inside patterns.ts, so the pattern lists now live on
//     WatchdogConfig (see config.ts) and are threaded through explicitly below.
//   - time-parser splits parsing from waiting: parseResetTime(message) yields a
//     ParsedResetTime | null, which calculateWaitMs(parsed, opts) then turns
//     into a wait duration — calculateWaitMs does not take the raw message.

export type { WatchdogConfig } from './config'

export type WatchdogStatus = 'monitoring' | 'waiting' | 'overload' | 'safeguard'

export interface WatchdogPublicState {
  sessionId: string
  status: WatchdogStatus
  attempts: number
  overloadAttempts: number
  safeguardAttempts: number
  waitUntil: number | null
  gaveUp: boolean
  lastAction: string | null
  updatedAt: number
}

export interface WatchdogAdapter {
  getTail(): string
  isSessionAlive(): boolean
  send(text: string): void
  now(): number
  log(level: 'info' | 'warn' | 'error', msg: string): void
  onStateChange(state: WatchdogPublicState): void
}

// Only a usage-limit banner in the live tail counts — a banner scrolled out of
// view, or quoted limit text elsewhere in scrollback, is not the current state.
const USAGE_TAIL_LINES = 12

// A StopFailure event arriving more than this after our last event-path retry
// send is a NEW overload incident (the retry turn succeeded in between), not
// an escalation of the old one.
const OVERLOAD_INCIDENT_GAP_MS = 15 * 60_000

// Fixed cooldown after sending a rate-limit retry before we'd re-check/re-fire.
const WAITING_RESEND_COOLDOWN_MS = 30_000

// Recheck interval used once a state has given up, so the timer-driven tick()
// doesn't re-evaluate (and re-log) a stale incident in a tight loop.
const GIVEUP_RECHECK_MS = 5 * 60_000

function applyJitter(ms: number, jitterPct: number, rand: () => number): number {
  if (!jitterPct) return ms
  const factor = 1 + (rand() * 2 - 1) * (jitterPct / 100) // +/-jitterPct%
  return Math.max(0, Math.round(ms * factor))
}

export class SessionWatchdog {
  private status: WatchdogStatus = 'monitoring'
  private attempts = 0
  private overloadAttempts = 0
  private safeguardAttempts = 0
  private waitUntil: number | null = null
  private gaveUp = false
  private lastAction: string | null = null
  private updatedAt: number

  // Overload sub-state, distinct from the usage-limit fields above.
  private overloadTotalWaitMs = 0
  private overloadGaveUpLogged = false
  private lastEventRetryAt: number | null = null
  // Memoizes the exact tail text a send already handled, so a still-visible
  // render doesn't double-fire a second backoff (upstream's _eventHandledBanner).
  private lastHandledOverloadTail: string | null = null
  // Marks the current overload window as opened by handleHookEvent (edge-
  // triggered, authoritative) rather than the tail scraper — see tickOverload.
  private viaEvent = false
  // The tail captured when a hook event OPENED the current overload incident.
  // At fire time the event path re-verifies against this: if the tail advanced,
  // the session moved on since the event, so clear instead of firing a spurious
  // retry into a silently-recovered session (adversarial FINDING 3). Null when
  // the incident was not event-opened.
  private eventTailSnapshot: string | null = null

  private waitingGaveUpLogged = false
  private safeguardGaveUpLogged = false

  private disposed = false

  private readonly config: WatchdogConfig
  private readonly rand: () => number
  private readonly sessionId: string
  private readonly adapter: WatchdogAdapter

  constructor(sessionId: string, adapter: WatchdogAdapter, config?: Partial<WatchdogConfig>, rand: () => number = Math.random) {
    this.sessionId = sessionId
    this.adapter = adapter
    this.config = resolveWatchdogConfig(config)
    this.rand = rand
    this.updatedAt = this.adapter.now()
  }

  getState(): WatchdogPublicState {
    return {
      sessionId: this.sessionId,
      status: this.status,
      attempts: this.attempts,
      overloadAttempts: this.overloadAttempts,
      safeguardAttempts: this.safeguardAttempts,
      waitUntil: this.waitUntil,
      gaveUp: this.gaveUp,
      lastAction: this.lastAction,
      updatedAt: this.updatedAt,
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private emit(action: string): void {
    this.updatedAt = this.adapter.now()
    this.lastAction = action
    this.adapter.onStateChange(this.getState())
  }

  private overloadBaseWaitMs(attemptIndex: number): number {
    const { backoffSeconds, steadyStateSeconds } = this.config.overload
    const secs = attemptIndex < backoffSeconds.length ? backoffSeconds[attemptIndex] : steadyStateSeconds
    return secs * 1000
  }

  private nextOverloadWaitMs(attemptIndex: number): number {
    return applyJitter(this.overloadBaseWaitMs(attemptIndex), this.config.overload.jitterPct, this.rand)
  }

  private resetOverload(): void {
    this.overloadAttempts = 0
    this.overloadTotalWaitMs = 0
    this.overloadGaveUpLogged = false
    this.viaEvent = false
    this.eventTailSnapshot = null
    // lastHandledOverloadTail is intentionally NOT cleared here: the banner it
    // suppresses can still be on screen right after recovery. It has its own
    // lifecycle, cleared once the banner actually leaves the tail.
  }

  private resetSafeguard(): void {
    this.safeguardAttempts = 0
    this.safeguardGaveUpLogged = false
  }

  private toMonitoring(action: string): void {
    this.status = 'monitoring'
    this.waitUntil = null
    this.gaveUp = false
    this.emit(action)
  }

  // ---- entry points ----

  feed(): void {
    if (this.disposed) return
    const tail = this.adapter.getTail()
    switch (this.status) {
      case 'monitoring':
        this.feedMonitoring(tail)
        return
      case 'waiting':
        this.feedWaiting(tail)
        return
      case 'overload':
        this.feedOverload(tail)
        return
      case 'safeguard':
        this.feedSafeguard(tail)
        return
    }
  }

  // StopFailure fast path. Authoritative to OPEN an incident (edge-triggered by
  // the hook, no scraping needed to start the backoff) — but the fire-time send
  // is still re-verified against the tail snapshot (see tickOverload /
  // eventTailSnapshot), so a silent recovery during the backoff does not fire a
  // spurious retry. Only the two retryable error kinds start an incident;
  // anything else is ignored so an out-of-date hook writer (still emitting a
  // retired error kind) can't start a backoff no policy owns.
  handleHookEvent(evt: { event: string; error?: string }): void {
    if (this.disposed) return
    if (!this.config.overload.enabled) return
    if (evt.error !== 'overloaded' && evt.error !== 'server_error') return

    // A hook-driven overload must never override a real usage-limit wait, nor
    // resurrect a latched give-up. Only allow it to (re)enter overload from
    // 'monitoring', or escalate an existing non-given-up 'overload' incident —
    // anything else (an active 'waiting', a latched give-up in 'safeguard' or
    // 'waiting', or a live 'safeguard' flag) is ignored.
    const canEnterOverload = this.status === 'monitoring' || (this.status === 'overload' && !this.gaveUp)
    if (!canEnterOverload) {
      this.adapter.log('info', `StopFailure(${evt.error}) ignored: status=${this.status} gaveUp=${this.gaveUp} outranks a hook-driven overload.`)
      return
    }

    const tail = this.adapter.getTail()

    if (isWorking(tail) && !isInternalRetry(tail)) {
      // Self-recovered between the failing turn and this event landing.
      this.resetOverload()
      if (this.status === 'overload') this.toMonitoring('overload cleared (self-recovered before hook event processed)')
      return
    }

    if (this.lastEventRetryAt !== null && this.adapter.now() - this.lastEventRetryAt > OVERLOAD_INCIDENT_GAP_MS) {
      this.resetOverload()
    }

    const capMs = this.config.overload.maxTotalWaitMinutes * 60_000
    if (this.overloadTotalWaitMs >= capMs) {
      this.gaveUp = true
      this.status = 'overload'
      if (!this.overloadGaveUpLogged) {
        this.overloadGaveUpLogged = true
        this.adapter.log('warn', `Overload backoff cap reached (maxTotalWaitMinutes=${this.config.overload.maxTotalWaitMinutes}). Giving up until it clears.`)
      }
      this.emit('overload give-up (hook event, cap already reached)')
      return
    }

    const w = this.nextOverloadWaitMs(this.overloadAttempts)
    this.overloadTotalWaitMs += w
    this.waitUntil = this.adapter.now() + w
    this.status = 'overload'
    this.gaveUp = false
    this.viaEvent = true
    this.eventTailSnapshot = tail // fire-time re-verify baseline (FINDING 3)
    this.emit(`overload incident detected via hook event (error=${evt.error}); backing off ${Math.round(w / 1000)}s`)
  }

  // Timer-driven: check wait expiry for the active status and fire a retry.
  // The wiring layer owns the interval; this class creates no timers.
  tick(): void {
    if (this.disposed) return
    switch (this.status) {
      case 'waiting':
        this.tickWaiting()
        return
      case 'overload':
        this.tickOverload()
        return
      case 'safeguard':
        this.tickSafeguard()
        return
      case 'monitoring':
        return
    }
  }

  // ---- monitoring ----

  private feedMonitoring(tail: string): void {
    // Usage-limit (hours-scale reset) takes precedence over overload/safeguard.
    if (isRateLimited(tail, [], USAGE_TAIL_LINES) && !isWorking(tail)) {
      this.enterWaiting(tail)
      return
    }

    if (this.config.overload.enabled) {
      const present = detectOverload(tail, this.config.overload.patterns)
      if (present && !isInternalRetry(tail)) {
        if (this.lastHandledOverloadTail === tail) return // event path already handled this exact render
        this.enterOverload()
        return
      }
      if (!present) this.lastHandledOverloadTail = null // banner gone -> a future match is a fresh incident
    }

    if (this.config.safeguard.enabled && detectSafeguard(tail, this.config.safeguard.patterns)) {
      this.enterSafeguard()
    }
  }

  private enterWaiting(tail: string): void {
    const message = findRateLimitMessage(tail)
    const parsed = message ? parseResetTime(message) : null
    const waitMs = calculateWaitMs(parsed, {
      marginSeconds: this.config.marginSeconds,
      fallbackWaitHours: this.config.fallbackWaitHours,
      now: new Date(this.adapter.now()),
    })
    this.status = 'waiting'
    this.attempts = 0
    this.waitUntil = this.adapter.now() + waitMs
    this.gaveUp = false
    this.waitingGaveUpLogged = false
    this.adapter.log('info', `Rate limit detected${message ? `: "${message}"` : ''}. Waiting ${Math.round(waitMs / 1000)}s.`)
    this.emit('rate limit detected; waiting for reset')
  }

  private enterOverload(): void {
    this.resetOverload()
    this.status = 'overload'
    this.gaveUp = false
    const capMs = this.config.overload.maxTotalWaitMinutes * 60_000
    const w = this.nextOverloadWaitMs(0)
    if (w > capMs) {
      // Degenerate config: the first backoff already exceeds the cap. Force the
      // cap to trip on the next tick rather than entering a real retry loop.
      this.overloadTotalWaitMs = capMs
      this.waitUntil = this.adapter.now()
      this.emit('overload detected (degenerate backoff config exceeds cap)')
      return
    }
    this.overloadTotalWaitMs = w
    this.waitUntil = this.adapter.now() + w
    this.adapter.log('warn', `Overload/transient API error detected. Backing off ${Math.round(w / 1000)}s before retry.`)
    this.emit('overload detected; backing off')
  }

  private enterSafeguard(): void {
    this.resetSafeguard()
    this.status = 'safeguard'
    this.gaveUp = false
    this.waitUntil = this.adapter.now() + this.config.safeguard.retryDelaySeconds * 1000
    this.adapter.log('warn', `Safeguard/AUP flag detected — often a false positive. Will retry up to ${this.config.safeguard.maxRetries}x every ${this.config.safeguard.retryDelaySeconds}s.`)
    this.emit('safeguard flag detected')
  }

  // ---- waiting (usage limit) ----

  private feedWaiting(tail: string): void {
    if (resumedAfterLimit(tail, USAGE_TAIL_LINES)) {
      this.attempts = 0
      this.adapter.log('info', 'User already continued. Attempt counter reset.')
      this.toMonitoring('user continued past rate limit')
      return
    }
    if (!isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.attempts = 0
      this.toMonitoring('rate limit banner cleared')
    }
  }

  private tickWaiting(): void {
    const now = this.adapter.now()
    if (this.waitUntil === null || now < this.waitUntil) return

    const tail = this.adapter.getTail()
    if (resumedAfterLimit(tail, USAGE_TAIL_LINES) || !isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.attempts = 0
      this.toMonitoring('rate limit cleared before retry fired')
      return
    }
    if (isWorking(tail)) {
      this.waitUntil = now + WAITING_RESEND_COOLDOWN_MS
      return
    }
    if (!this.adapter.isSessionAlive()) return

    if (this.attempts >= this.config.maxRetries) {
      this.gaveUp = true
      this.waitUntil = now + GIVEUP_RECHECK_MS
      if (!this.waitingGaveUpLogged) {
        this.waitingGaveUpLogged = true
        this.adapter.log('warn', `Max retries (${this.config.maxRetries}) reached. Will not send further retries until the rate limit clears.`)
        this.emit('max retries reached; giving up on rate-limit retries')
      }
      return
    }

    // The pane must be SENDABLE, not merely idle (#266 BLOCKER-2/MAJOR-3): a
    // retry typed into an open menu SELECTS (a permission prompt's "1. Yes"
    // auto-approves), and typed beside the user's draft it mangles and submits
    // their text. Refusal defers without consuming an attempt — a pane waiting
    // on a human stays theirs, re-checked next tick.
    const gate = this.sendGate(tail, now, WAITING_RESEND_COOLDOWN_MS)
    if (!gate) return

    this.attempts++
    this.waitUntil = now + WAITING_RESEND_COOLDOWN_MS
    this.adapter.log('info', `Sending retry after rate limit reset (attempt ${this.attempts}).`)
    this.adapter.send(this.config.retryMessage)
    this.emit(`sent retry after rate limit reset (attempt ${this.attempts})`)
  }

  /** Shared refusal path for the three send sites: false = deferred (the tail
   *  shows a menu or the user's draft), with the wait pushed out by `deferMs`
   *  and no attempt consumed. */
  private sendGate(tail: string, now: number, deferMs: number): boolean {
    const gate = canSendNow(tail)
    if (gate.ok) return true
    this.waitUntil = now + deferMs
    this.adapter.log(
      'info',
      gate.reason === 'menu'
        ? 'Retry deferred: an interactive menu/prompt is open — an automated line would select in it.'
        : "Retry deferred: the input box carries the user's unsubmitted draft.",
    )
    return false
  }

  // ---- overload ----

  private feedOverload(tail: string): void {
    if (isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.resetOverload()
      this.enterWaiting(tail)
      return
    }
    if (isWorking(tail) && !isInternalRetry(tail)) {
      this.resetOverload()
      this.toMonitoring('overload cleared (session recovered)')
      return
    }
    // Edge-triggered event incidents may carry no scraped banner at all — the
    // hook event was the authoritative signal to OPEN the incident, so "no
    // overload text in the tail" is NOT a clearing signal for it. Instead the
    // event path clears when the tail ADVANCED since the snapshot taken at the
    // event (a silent recovery, FINDING 3); the scraper path still clears on
    // absent overload text.
    if (this.viaEvent) {
      if (this.eventTailSnapshot !== null && tail !== this.eventTailSnapshot) {
        this.resetOverload()
        this.toMonitoring('overload cleared (session advanced since the hook event)')
      }
    } else if (!detectOverload(tail, this.config.overload.patterns)) {
      this.resetOverload()
      this.toMonitoring('overload text no longer present')
    }
  }

  private tickOverload(): void {
    const now = this.adapter.now()
    if (this.waitUntil === null || now < this.waitUntil) return

    const tail = this.adapter.getTail()

    if (isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.resetOverload()
      this.enterWaiting(tail)
      return
    }
    if (isWorking(tail) && !isInternalRetry(tail)) {
      this.resetOverload()
      this.toMonitoring('overload cleared (session recovered)')
      return
    }
    // Fire-time re-verify (FINDING 3): an event-opened incident does not require
    // scraped overload text, so re-check by whether the tail ADVANCED since the
    // event snapshot — if it did, the session recovered silently, so clear rather
    // than send a spurious retry. The scraper path still clears on absent text.
    if (this.viaEvent) {
      if (this.eventTailSnapshot !== null && tail !== this.eventTailSnapshot) {
        this.resetOverload()
        this.toMonitoring('overload cleared (session advanced since the hook event)')
        return
      }
    } else if (!detectOverload(tail, this.config.overload.patterns)) {
      this.resetOverload()
      this.toMonitoring('overload text no longer present')
      return
    }
    if (isInternalRetry(tail)) {
      // Claude is still internally retrying — not terminal yet. Defer without
      // consuming an attempt.
      this.waitUntil = now + this.overloadBaseWaitMs(0)
      return
    }
    if (!this.adapter.isSessionAlive()) return

    const capMs = this.config.overload.maxTotalWaitMinutes * 60_000
    if (this.overloadTotalWaitMs >= capMs) {
      this.gaveUp = true
      this.waitUntil = now + GIVEUP_RECHECK_MS
      if (!this.overloadGaveUpLogged) {
        this.overloadGaveUpLogged = true
        this.adapter.log('warn', `Overload backoff cap reached (maxTotalWaitMinutes=${this.config.overload.maxTotalWaitMinutes}). Giving up — will not retry until the error clears.`)
        this.emit('overload backoff cap reached; giving up')
      }
      return
    }

    // Same sendability gate as the waiting path (#266 BLOCKER-2/MAJOR-3);
    // deferred at the base backoff, no attempt consumed, no cumulative spend.
    if (!this.sendGate(tail, now, this.overloadBaseWaitMs(0))) return

    this.overloadAttempts++
    const w = this.nextOverloadWaitMs(this.overloadAttempts)
    this.overloadTotalWaitMs += w
    this.waitUntil = now + w
    if (this.viaEvent) this.lastEventRetryAt = now
    this.viaEvent = false
    this.lastHandledOverloadTail = tail
    this.adapter.log('info', `Sending overload retry (attempt ${this.overloadAttempts}). Next backoff ${Math.round(w / 1000)}s. Cumulative wait ${Math.round(this.overloadTotalWaitMs / 1000)}s.`)
    this.adapter.send(this.config.overload.retryMessage)
    this.emit(`sent retry after overload backoff (attempt ${this.overloadAttempts})`)
  }

  // ---- safeguard ----

  private feedSafeguard(tail: string): void {
    if (isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.resetSafeguard()
      this.enterWaiting(tail)
      return
    }
    if (isWorking(tail)) return // in flight; recovery is decided at the next idle read
    if (!detectSafeguard(tail, this.config.safeguard.patterns)) {
      this.resetSafeguard()
      this.toMonitoring('safeguard flag cleared')
    }
  }

  private tickSafeguard(): void {
    const now = this.adapter.now()
    if (this.waitUntil === null || now < this.waitUntil) return

    const tail = this.adapter.getTail()
    if (isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.resetSafeguard()
      this.enterWaiting(tail)
      return
    }
    if (isWorking(tail)) {
      // In flight (our own retry, or the user typing). Defer WITHOUT consuming
      // or resetting the counter — a tick landing mid-retry must not zero it.
      this.waitUntil = now + this.config.safeguard.retryDelaySeconds * 1000
      return
    }
    if (!detectSafeguard(tail, this.config.safeguard.patterns)) {
      this.resetSafeguard()
      this.toMonitoring('safeguard flag cleared')
      return
    }
    if (this.safeguardAttempts >= this.config.safeguard.maxRetries) {
      this.gaveUp = true
      this.waitUntil = now + GIVEUP_RECHECK_MS
      if (!this.safeguardGaveUpLogged) {
        this.safeguardGaveUpLogged = true
        this.adapter.log('warn', `Safeguard flag persisted after ${this.config.safeguard.maxRetries} retries. Giving up until it clears.`)
        this.emit('safeguard retries exhausted; giving up')
      }
      return
    }
    if (!this.adapter.isSessionAlive()) return

    // Same sendability gate as the waiting path (#266 BLOCKER-2/MAJOR-3).
    if (!this.sendGate(tail, now, this.config.safeguard.retryDelaySeconds * 1000)) return

    this.safeguardAttempts++
    this.waitUntil = now + this.config.safeguard.retryDelaySeconds * 1000
    this.adapter.log('info', `Sending safeguard retry (attempt ${this.safeguardAttempts}/${this.config.safeguard.maxRetries}).`)
    this.adapter.send(this.config.safeguard.retryMessage)
    this.emit(`sent retry after safeguard flag (attempt ${this.safeguardAttempts})`)
  }
}
