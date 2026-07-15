import { HooksGatewayProxy } from './hooks-gateway-proxy'
import { createInitialHealth, computeThroughput } from '../../shared/service-health'
import { IPC } from '../../shared/ipc-channels'
import type { ServiceHealth, ServiceLogEntry, DiagnosticsSnapshot, ThroughputSample } from '../../shared/service-health'
import type { ChildTransport, FromChildMessage } from './service-transport'

export interface ForkedChild {
  transport: ChildTransport
  kill: () => void
  onExit: (cb: () => void) => void
}

export interface ServiceSupervisorOptions {
  forkChild: () => ForkedChild
  defaultPort: number
  emit: (channel: string, payload: unknown) => void
  now?: () => number   // injectable clock for tests
  maxRestarts?: number // fail open to in-process after this many failed restarts (default 5)
  // Logs v2 (Task 8): sink for transcript paths the child gateway lifts from hook
  // POSTs (earliest + exact discovery source). Routed to main's transcript binder.
  // Also handed to the in-process gateway on fail-open so discovery survives.
  onTranscriptPath?: (sessionId: string, path: string) => void
}

const LOG_CAP = 200

export class ServiceSupervisor {
  private opts: ServiceSupervisorOptions
  private now: () => number
  private health: ServiceHealth = createInitialHealth('hooks', 'Hooks gateway')
  // Last (eventsTotal, ts) sample throughput was computed against — see
  // computeThroughput. Reset to null on respawn so a restart's counter reset
  // can't read as a negative/huge rate.
  private prevThroughput: ThroughputSample | null = null
  private log: ServiceLogEntry[] = []
  private child: ForkedChild | null = null
  private proxy: HooksGatewayProxy | null = null
  private shuttingDown = false
  // Set once we commit to fail-open. activateFallback()'s own child.kill() fires an
  // exit event; this flag (set BEFORE the kill) stops that exit re-entering
  // onChildExit and logging a spurious second 'falling open'.
  private fellOpen = false
  private restarts = 0
  // backoffIdx only advances (never reset on a healthy bind) — a conservative
  // D1a choice: slower escalation toward fail-open is safer than restart thrash.
  // A "healthy for N seconds -> reset the counters" policy is a hardening follow-up.
  private backoffIdx = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private static BACKOFFS = [250, 1000, 4000, 4000, 4000]

  constructor(opts: ServiceSupervisorOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
  }

  getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    return { capturedAt: this.now(), services: [{ ...this.health }], log: [...this.log] }
  }

  getProxy(): HooksGatewayProxy | null { return this.proxy }

  private appendLog(level: ServiceLogEntry['level'], code: string, message: string): void {
    this.log.push({ ts: this.now(), serviceId: 'hooks', level, code, message })
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
  }

  // Push the live diagnostics snapshot to the renderer. Called after every
  // health mutation (and after a forwarded child log lands) so the health pill +
  // services console reflect reality without polling. Guarded: the window may be
  // gone during teardown.
  private pushHealth(): void {
    try { this.opts.emit(IPC.SERVICE_HEALTH_UPDATE, this.getDiagnosticsSnapshot()) } catch { /* window gone */ }
  }

  // The supervisor owns the SINGLE transport subscription (ChildTransport.onMessage
  // is last-writer-wins). It consumes bound/health/log itself and forwards the
  // proxy-relevant messages (event/dropped/permission-open) via handleChildMessage.
  private onChildMessage(m: FromChildMessage): void {
    // Once we've failed open (or are shutting down) the child is dead; ignore any
    // messages still draining out of the pipe so a stale `bound`/`health` can't
    // flip the host back to utility-process and clobber the `degraded` state.
    if (this.shuttingDown || this.proxy?.isInProcessFallback()) return
    if (m.type === 'bound') {
      this.health = {
        ...this.health,
        state: 'listening',
        host: 'utility-process',
        port: m.port,
        pid: m.pid,
        startedAt: this.health.startedAt ?? this.now(),
      }
      this.appendLog('info', 'bound', `bound :${m.port} pid=${m.pid}`)
      this.pushHealth()
    } else if (m.type === 'health') {
      const ts = this.now()
      const sample: ThroughputSample = { eventsTotal: m.eventsTotal, ts }
      const throughputPerSec = computeThroughput(this.prevThroughput, sample)
      this.prevThroughput = sample
      this.health = {
        ...this.health,
        inFlight: m.inFlight,
        eventsTotal: m.eventsTotal,
        dropsTotal: m.dropsTotal,
        throughputPerSec,
        childLoopStallsLastMin: m.stallsLastMin,
        lastHeartbeatAt: ts,
      }
      this.pushHealth()
    } else if (m.type === 'log') {
      this.log.push(m.entry)
      if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
      this.pushHealth()
    } else if (m.type === 'bind-failed') {
      this.health = { ...this.health, state: 'crashed', lastError: { message: m.error, ts: this.now() } }
      this.appendLog('error', 'bind-failed', `hooks child failed to bind: ${m.error}`)
      this.pushHealth()
      // Escalate like an exit: the child is alive but useless. Kill it so the normal
      // exit-driven restart/backoff -> fail-open path runs (single-owner of that logic).
      // Do NOT forward bind-failed to the proxy.
      try { this.child?.kill() } catch { /* best-effort */ }
      return
    } else if (m.type === 'transcript-path') {
      // Logs v2 (Task 8): hand the lifted transcript path to the binder. A throw
      // in the sink must not break child-message routing.
      try { this.opts.onTranscriptPath?.(m.sid, m.path) } catch { /* sink must not break routing */ }
      return
    }
    // Forward `bound` to the proxy too so its status/HOOKS_STATUS broadcast and
    // start()-await-bound resolve in the production (supervisor-driven) path, not
    // just when the proxy self-subscribes.
    if (m.type === 'bound' || m.type === 'event' || m.type === 'dropped' || m.type === 'permission-open') {
      this.proxy?.handleChildMessage(m)
    }
  }

  start(): HooksGatewayProxy {
    this.spawnChild()
    return this.proxy!
  }

  /** User-requested restart of a service. In utility-process mode this kills the
   *  current child and immediately respawns, resetting the restart/backoff/fail-open
   *  counters so a manual restart is a clean slate (not counted against the fail-open
   *  budget). Declines in in-process fallback (live un-fail-open is deferred, spec §7)
   *  and during shutdown. The old child's kill fires its onExit, but the spawnChild
   *  guard (`this.child === c`) ignores a non-current child's exit so no spurious
   *  extra spawn occurs. */
  manualRestart(serviceId: string): { ok: boolean; reason?: string } {
    if (serviceId !== 'hooks') return { ok: false, reason: 'unknown-service' }
    if (this.shuttingDown) return { ok: false, reason: 'shutting-down' }
    if (this.proxy?.isInProcessFallback()) return { ok: false, reason: 'fallback' } // live revert deferred (spec §7)
    this.appendLog('info', 'manual-restart', 'manual restart requested')
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.restarts = 0
    this.backoffIdx = 0
    this.fellOpen = false
    this.health = { ...this.health, restartCount: 0 }
    try { this.child?.kill() } catch { /* best-effort */ }
    this.spawnChild()   // rebinds the long-lived proxy to the fresh child + replays secrets + start
    this.pushHealth()
    return { ok: true }
  }

  private spawnChild(): void {
    const c = this.opts.forkChild()
    this.child = c
    if (!this.proxy) {
      this.proxy = new HooksGatewayProxy({
        transport: c.transport,
        defaultPort: this.opts.defaultPort,
        emit: this.opts.emit,
        selfSubscribe: false,
        onTranscriptPath: this.opts.onTranscriptPath,
      })
    } else {
      this.proxy.rebindTransport(c.transport)   // point the long-lived proxy at the NEW child
    }
    c.transport.onMessage((m) => this.onChildMessage(m))
    // S1 replay-before-listen: register the known secrets on the new child BEFORE it
    // binds/announces, so a request landing right after bind validates against a
    // populated secret map. The child applies `register` synchronously on receipt and
    // only binds on `start`, so the ordering holds.
    this.proxy.replaySecretsTo(c.transport)
    // Fresh child = fresh per-instance counters; forget the prior throughput
    // sample so the next health beat starts a clean interval (no negative rate).
    this.prevThroughput = null
    this.health = { ...this.health, state: this.restarts > 0 ? 'restarting' : 'starting' }
    this.appendLog('info', 'child-up', `hooks child forked (restart ${this.restarts})`)
    this.pushHealth()
    void this.proxy.start()
    c.onExit(() => { if (this.child === c) this.onChildExit() })
  }

  private onChildExit(): void {
    // Ignore exits once shutting down OR once we've committed to fail-open (the
    // latter so activateFallback()'s own child.kill() can't re-enter and re-run).
    if (this.shuttingDown || this.fellOpen) return
    this.health = { ...this.health, state: 'crashed', lastError: { message: 'child exited', ts: this.now() } }
    this.appendLog('error', 'crashed', 'hooks child exited unexpectedly')
    this.pushHealth()
    if (this.restarts >= (this.opts.maxRestarts ?? 5)) { this.activateFallback(); return }
    const delay = ServiceSupervisor.BACKOFFS[Math.min(this.backoffIdx, ServiceSupervisor.BACKOFFS.length - 1)]
    this.backoffIdx++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.shuttingDown) return   // shutdown() raced the backoff — do not resurrect the child
      this.restarts++
      this.health = { ...this.health, restartCount: this.restarts }
      this.spawnChild()
    }, delay)
  }

  /** Tear down the child path and run the gateway in-process (proxy.failOpen). */
  private activateFallback(): void {
    this.fellOpen = true   // BEFORE kill() so the kill's exit event can't re-enter onChildExit
    this.appendLog('warn', 'fallback', 'falling open to in-process gateway')
    this.child?.kill()   // free the port BEFORE the in-process gateway binds (mutual exclusion)
    this.health = { ...this.health, host: 'in-process-fallback', state: 'degraded', restartCount: this.restarts }
    this.proxy?.failOpen()
    this.pushHealth()
  }

  shutdown(): void {
    this.shuttingDown = true
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
    try { this.child?.kill() } catch { /* best-effort */ }
  }
}
