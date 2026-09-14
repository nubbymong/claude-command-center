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
  hasClaudeInputChrome,
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

/**
 * #605: the three auto-retry checks, each independently switchable. Seeded from
 * the resolved config when the watchdog arms, then live-settable PER SESSION via
 * setChecks() -- turning one off stops that check both detecting and typing, for
 * this run only. The silence/sleep indicator is NOT here: it lives in
 * WatchdogManager, is status-only, and never sends, so it is never gated.
 */
export interface WatchdogChecks {
  rateLimit: boolean
  overload: boolean
  safeguard: boolean
}

export interface WatchdogPublicState {
  sessionId: string
  status: WatchdogStatus
  /** #605 (ADR-009 round 1, MINOR): false on the state pushed when a watcher is
   *  TORN DOWN. The renderer keys its pill and its menu block off this, so a
   *  stopped watchdog leaves no "off" pill and no dead toggles behind. */
  armed: boolean
  /** #605: which checks are live for this session right now. */
  checks: WatchdogChecks
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
  /** The DIM-BLANKED companion of getTail() (#418): same lines, every dim cell
   *  a space. The send gate uses it to tell an empty prompt wearing a dim
   *  placeholder ("Press up to edit queued messages") from a real draft.
   *  Optional — without it the gate reads text alone and fails closed (defers
   *  on any caret text, placeholder or not). */
  getTailNonDim?(): string
  isSessionAlive(): boolean
  /** SSH session: the pane is drawn by a REMOTE host and can be anything (a
   *  shell, a pager, a `[sudo] password:` prompt, a REPL), so the send gate is
   *  hardened — it requires positive Claude input chrome AND reads raw (the
   *  dim/non-dim companion is remote-controlled, so it is dropped, failing
   *  closed on any caret text). Absent/false for a LOCAL session, whose pane is
   *  always Claude's own renderer. */
  requireClaudeChrome?: boolean
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
  /** #605: per-session, live-mutable. Seeded from config in the constructor. */
  private checks: WatchdogChecks
  /**
   * #605: a check switched OFF while its own incident was live PARKS that
   * incident's spend -- it neither ends the incident nor abandons it.
   *
   * ADR-009 round 1 (MAJOR): without this, the trip through 'monitoring' let
   * the next feed() re-open the very same banner through enterWaiting /
   * enterOverload / enterSafeguard, each of which zeroes the attempt budget and
   * clears gaveUp. An off/on toggle pair therefore handed back a FULL
   * allowance, so a user could re-submit a safeguard-FLAGGED message without
   * bound, and a partly-spent budget was refunded in full.
   *
   * ADR-009 round 2 (MAJOR): round 1 closed that by refusing to re-open a
   * suspended incident at all, which over-corrected -- nothing cleared the
   * suspension when the check came back ON, so a live incident stayed
   * permanently disarmed while the pill and the menu still reported the check
   * as on. What must survive the toggle is the SPEND, not the abandonment: the
   * counters are snapshotted here and restored by the enter* methods, so
   * switching the check back on resumes the same incident with its budget
   * already spent (and, since every give-up is derived from these counters, a
   * given-up incident comes back given up). A park is discarded by
   * feedMonitoring the moment its condition genuinely leaves the screen --
   * evaluated even while the check is off, so a park can never outlive the
   * incident that created it and a later banner is a fresh incident with a full
   * budget. Mirrors the existing refusal to resurrect a latched give-up
   * (handleHookEvent).
   *
   * The overload park also records how its incident was OPENED, because the two
   * kinds have different "it is over" rules: a scraped incident ends when the
   * banner leaves the tail, but an event-opened one may never have had a banner
   * at all and ends when the tail ADVANCES past the snapshot taken at the event
   * (see feedOverload). Keying its discard on absent banner text would throw
   * every hook-driven park away on the next feed.
   */
  private parkedBudget: {
    rateLimit: { attempts: number } | null
    overload: { attempts: number; totalWaitMs: number; viaEvent: boolean; eventTailSnapshot: string | null } | null
    safeguard: { attempts: number } | null
  } = { rateLimit: null, overload: null, safeguard: null }
  private readonly rand: () => number
  private readonly sessionId: string
  private readonly adapter: WatchdogAdapter

  constructor(sessionId: string, adapter: WatchdogAdapter, config?: Partial<WatchdogConfig>, rand: () => number = Math.random) {
    this.sessionId = sessionId
    this.adapter = adapter
    this.config = resolveWatchdogConfig(config)
    this.checks = {
      rateLimit: this.config.rateLimitEnabled,
      overload: this.config.overload.enabled,
      safeguard: this.config.safeguard.enabled,
    }
    this.rand = rand
    this.updatedAt = this.adapter.now()
  }

  getState(): WatchdogPublicState {
    return {
      sessionId: this.sessionId,
      status: this.status,
      armed: true,
      checks: { ...this.checks },
      attempts: this.attempts,
      overloadAttempts: this.overloadAttempts,
      safeguardAttempts: this.safeguardAttempts,
      waitUntil: this.waitUntil,
      gaveUp: this.gaveUp,
      lastAction: this.lastAction,
      updatedAt: this.updatedAt,
    }
  }

  /**
   * #605: switch individual checks on/off for THIS session, in real time.
   *
   * A check switched OFF while its own incident is live drops the session back
   * to monitoring: nothing is typed, the pending wait is dropped, and the badge
   * stops advertising a retry that will never fire. Its spend is PARKED rather
   * than discarded (see parkedBudget), so switching the check back on resumes
   * the same incident with the budget it had already used up. Switching a check
   * ON never fabricates an incident -- the next feed() re-detects if the
   * condition is still on screen.
   */
  setChecks(partial: Partial<WatchdogChecks>): void {
    if (this.disposed) return
    const next: WatchdogChecks = { ...this.checks, ...partial }
    if (next.rateLimit === this.checks.rateLimit
      && next.overload === this.checks.overload
      && next.safeguard === this.checks.safeguard) return
    this.checks = next
    // Leaving a live incident PARKS its spend (see parkedBudget): the live
    // counters are zeroed so 'monitoring' reads clean, but the enter* methods
    // restore the parked values if the same condition is still on screen when
    // the check comes back on.
    if (this.status === 'waiting' && !next.rateLimit) {
      this.parkedBudget.rateLimit = { attempts: this.attempts }
      this.attempts = 0
      this.waitingGaveUpLogged = false
      this.toMonitoring('rate-limit check turned off')
      return
    }
    if (this.status === 'overload' && !next.overload) {
      this.parkedBudget.overload = {
        attempts: this.overloadAttempts,
        totalWaitMs: this.overloadTotalWaitMs,
        viaEvent: this.viaEvent,
        eventTailSnapshot: this.eventTailSnapshot,
      }
      this.resetOverload()
      this.toMonitoring('overload check turned off')
      return
    }
    if (this.status === 'safeguard' && !next.safeguard) {
      this.parkedBudget.safeguard = { attempts: this.safeguardAttempts }
      this.resetSafeguard()
      this.toMonitoring('safeguard check turned off')
      return
    }
    this.emit('checks changed')
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
    if (!this.checks.overload) return
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
      this.parkedBudget.overload = null // #605: the incident is over, so is its park
      this.resetOverload()
      if (this.status === 'overload') this.toMonitoring('overload cleared (self-recovered before hook event processed)')
      return
    }

    // #605: this is the FOURTH way into 'overload', and it must consume a parked
    // budget exactly as enterOverload does. Without it, an off/on toggle
    // followed by the next StopFailure event opens the incident from a zeroed
    // cumulative wait -- refunding the maxTotalWaitMinutes cap the park exists
    // to preserve, and un-giving-up an incident that had already given up.
    const parked = this.parkedBudget.overload
    this.parkedBudget.overload = null
    if (parked) {
      this.overloadAttempts = parked.attempts
      this.overloadTotalWaitMs = parked.totalWaitMs
    }

    // A gap this long means the retry turn in between succeeded: a NEW incident,
    // so the resumed spend above is correctly discarded with the live counters.
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
    this.discardStaleParks(tail)

    // Usage-limit (hours-scale reset) takes precedence over overload/safeguard.
    if (this.checks.rateLimit) {
      if (isRateLimited(tail, [], USAGE_TAIL_LINES) && !isWorking(tail)) {
        // Gated on checks.rateLimit here, so enterWaiting cannot decline.
        this.enterWaiting(tail)
        return
      }
    }

    if (this.checks.overload) {
      const present = detectOverload(tail, this.config.overload.patterns)
      if (!present) this.lastHandledOverloadTail = null // banner gone -> a future match is a fresh incident
      if (present && !isInternalRetry(tail)) {
        // #605: a PARKED incident resumes even on the exact render its last
        // retry handled -- the toggle is the user asking for it, and it is the
        // restored spend (not the render memo) that bounds the retries.
        if (this.lastHandledOverloadTail === tail && !this.parkedBudget.overload) return // event path already handled this exact render
        this.enterOverload()
        return
      }
    }

    if (this.checks.safeguard && detectSafeguard(tail, this.config.safeguard.patterns)) {
      this.enterSafeguard()
    }
  }

  /**
   * #605: a park lives exactly as long as the incident that created it.
   *
   * Runs on EVERY monitoring feed, before any branch that can return, and
   * regardless of whether its own check is currently on. Both properties are
   * load-bearing: a discard folded into the branch it belongs to is skipped
   * whenever an earlier branch returns first (so a stale park could be applied
   * to a later, unrelated incident), and a discard gated on the check being on
   * never fires at all for the case the park exists to serve -- the user
   * switched that check OFF.
   *
   * Each rule mirrors what the corresponding LIVE state already treats as "this
   * incident is over", so a parked incident and a live one end on exactly the
   * same evidence.
   */
  private discardStaleParks(tail: string): void {
    // feedWaiting: the banner leaving the tail ends the wait.
    if (this.parkedBudget.rateLimit && !isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.parkedBudget.rateLimit = null
    }
    // feedOverload: a scraped incident ends on absent banner text, but an
    // event-opened one may never have had any, and ends on the tail advancing
    // past the snapshot taken at the event.
    const over = this.parkedBudget.overload
    if (over) {
      const ended = over.viaEvent
        ? over.eventTailSnapshot !== null && tail !== over.eventTailSnapshot
        : !detectOverload(tail, this.config.overload.patterns)
      if (ended) this.parkedBudget.overload = null
    }
    // feedSafeguard/tickSafeguard: a retry in flight scrolls the flag out of the
    // tail window, so an absent flag only ends the incident at an IDLE read.
    // Without that guard a toggle during a retry discards the park, and the
    // next flag buys a full fresh budget for a message the safeguards flagged.
    if (this.parkedBudget.safeguard && !isWorking(tail)
      && !detectSafeguard(tail, this.config.safeguard.patterns)) {
      this.parkedBudget.safeguard = null
    }
  }

  /**
   * Opens a usage-limit wait. Returns TRUE when the session is now in
   * 'waiting', FALSE when this call DECLINED and made no transition at all.
   *
   * #605 (ADR-009 round 2, MAJOR): the false return matters because the four
   * escalation callers (feedOverload, tickOverload, feedSafeguard,
   * tickSafeguard) each zero their OWN incident's budget immediately before
   * calling this. A decline that silently made no transition therefore left the
   * session pinned in 'overload'/'safeguard' with a zeroed budget and a
   * waitUntil already in the past -- so once the interfering usage-limit banner
   * scrolled out of the tail, the next tick resumed sending with a FULL,
   * refunded budget. A false return hands the transition back to the caller,
   * which settles the machine in 'monitoring' instead.
   */
  private enterWaiting(tail: string): boolean {
    // #605: reached from feedMonitoring (already gated) AND from the
    // tickOverload/tickSafeguard escalations, which are not. With the
    // rate-limit check off, a usage limit is simply not this watchdog's
    // business: decline, and let the caller settle the machine.
    if (!this.checks.rateLimit) return false
    // #605: a parked incident resumes with the budget it had already spent, so
    // an off/on toggle over an unchanged screen buys no extra retries. The
    // give-up follows from the counter, so a given-up wait comes back given up.
    const parked = this.parkedBudget.rateLimit
    this.parkedBudget.rateLimit = null
    const message = findRateLimitMessage(tail)
    const parsed = message ? parseResetTime(message) : null
    const waitMs = calculateWaitMs(parsed, {
      marginSeconds: this.config.marginSeconds,
      fallbackWaitHours: this.config.fallbackWaitHours,
      now: new Date(this.adapter.now()),
    })
    this.status = 'waiting'
    this.attempts = parked ? parked.attempts : 0
    this.waitUntil = this.adapter.now() + waitMs
    // #605: a resumed incident that is already spent must READ as given up now,
    // not only after the next tick re-derives it -- otherwise the pill advertises
    // a retry that cannot fire. A fresh incident is unchanged.
    this.gaveUp = parked ? this.attempts >= this.config.maxRetries : false
    this.waitingGaveUpLogged = false
    this.adapter.log('info', `Rate limit detected${message ? `: "${message}"` : ''}. Waiting ${Math.round(waitMs / 1000)}s.`)
    this.emit('rate limit detected; waiting for reset')
    return true
  }

  private enterOverload(): void {
    // #605: a parked incident resumes at the backoff step and cumulative wait it
    // had reached, so an off/on toggle neither restarts the ramp nor refunds the
    // spend the maxTotalWaitMinutes cap is measured against.
    const parked = this.parkedBudget.overload
    this.parkedBudget.overload = null
    this.resetOverload()
    this.status = 'overload'
    if (parked) {
      this.overloadAttempts = parked.attempts
      this.overloadTotalWaitMs = parked.totalWaitMs
    }
    const capMs = this.config.overload.maxTotalWaitMinutes * 60_000
    // #605: see enterWaiting -- a resumed incident past its cap reads as given
    // up immediately. A fresh incident is unchanged (parked is null).
    this.gaveUp = parked ? this.overloadTotalWaitMs >= capMs : false
    const w = this.nextOverloadWaitMs(this.overloadAttempts)
    if (this.overloadTotalWaitMs + w > capMs) {
      // Degenerate config (or a resumed incident that has already spent the
      // cap): force the cap to trip on the next tick rather than entering a
      // real retry loop.
      this.overloadTotalWaitMs = capMs
      this.waitUntil = this.adapter.now()
      this.emit('overload detected (degenerate backoff config exceeds cap)')
      return
    }
    this.overloadTotalWaitMs += w
    this.waitUntil = this.adapter.now() + w
    this.adapter.log('warn', `Overload/transient API error detected. Backing off ${Math.round(w / 1000)}s before retry.`)
    this.emit('overload detected; backing off')
  }

  private enterSafeguard(): void {
    // #605: a parked incident resumes with its attempts already spent, so an
    // off/on toggle cannot buy another round of auto-submits for a message the
    // safeguards flagged. The give-up follows from the counter.
    const parked = this.parkedBudget.safeguard
    this.parkedBudget.safeguard = null
    this.resetSafeguard()
    this.status = 'safeguard'
    if (parked) this.safeguardAttempts = parked.attempts
    // #605: see enterWaiting -- a resumed incident past its cap reads as given
    // up immediately. A fresh incident is unchanged (parked is null).
    this.gaveUp = parked ? this.safeguardAttempts >= this.config.safeguard.maxRetries : false
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
    if (!this.checks.rateLimit) return
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
    // SSH: the pane is drawn by the remote and may be a shell, pager, REPL, or
    // auth/confirm prompt — none of which canSendNow (a denylist of CLAUDE
    // chrome) knows to refuse. Require positive Claude input chrome first, so a
    // retry can never be typed into a non-Claude pane (a bare shell, `[sudo]
    // password:`, `[y/N]`), including the case where claude has exited to the
    // shell mid-session. And read the gate RAW: the dim/non-dim companion is
    // remote-controlled over SSH, and its one lever — "this row is dim" — would
    // flip a real draft to sendable, so it is dropped (fail closed on any caret
    // text). A LOCAL session keeps the exact prior behaviour.
    if (this.adapter.requireClaudeChrome) {
      if (!hasClaudeInputChrome(tail)) {
        this.waitUntil = now + deferMs
        this.adapter.log('info', 'Retry deferred: the remote pane is not showing Claude — no automated line will be typed into it.')
        return false
      }
      const sshGate = canSendNow(tail)
      if (sshGate.ok) return true
      this.waitUntil = now + deferMs
      this.adapter.log(
        'info',
        sshGate.reason === 'menu'
          ? 'Retry deferred: an interactive menu/prompt is open — an automated line would select in it.'
          : "Retry deferred: the input box carries the user's unsubmitted draft.",
      )
      return false
    }
    const gate = canSendNow(tail, this.adapter.getTailNonDim?.())
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
      if (!this.enterWaiting(tail)) this.toMonitoring('overload cleared; the usage limit is not this watchdog\'s business')
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
    if (!this.checks.overload) return
    const now = this.adapter.now()
    if (this.waitUntil === null || now < this.waitUntil) return

    const tail = this.adapter.getTail()

    if (isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.resetOverload()
      if (!this.enterWaiting(tail)) this.toMonitoring('overload cleared; the usage limit is not this watchdog\'s business')
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
      if (!this.enterWaiting(tail)) this.toMonitoring('safeguard cleared; the usage limit is not this watchdog\'s business')
      return
    }
    if (isWorking(tail)) return // in flight; recovery is decided at the next idle read
    if (!detectSafeguard(tail, this.config.safeguard.patterns)) {
      this.resetSafeguard()
      this.toMonitoring('safeguard flag cleared')
    }
  }

  private tickSafeguard(): void {
    if (!this.checks.safeguard) return
    const now = this.adapter.now()
    if (this.waitUntil === null || now < this.waitUntil) return

    const tail = this.adapter.getTail()
    if (isRateLimited(tail, [], USAGE_TAIL_LINES)) {
      this.resetSafeguard()
      if (!this.enterWaiting(tail)) this.toMonitoring('safeguard cleared; the usage limit is not this watchdog\'s business')
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
