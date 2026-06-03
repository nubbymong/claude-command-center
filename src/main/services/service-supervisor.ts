import { HooksGatewayProxy } from './hooks-gateway-proxy'
import { createInitialHealth } from '../../shared/service-health'
import type { ServiceHealth, ServiceLogEntry, DiagnosticsSnapshot } from '../../shared/service-health'
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
}

const LOG_CAP = 200

export class ServiceSupervisor {
  private opts: ServiceSupervisorOptions
  private now: () => number
  private health: ServiceHealth = createInitialHealth('hooks', 'Hooks gateway')
  private log: ServiceLogEntry[] = []
  private child: ForkedChild | null = null
  private proxy: HooksGatewayProxy | null = null
  private shuttingDown = false
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
    } else if (m.type === 'health') {
      this.health = {
        ...this.health,
        inFlight: m.inFlight,
        eventsTotal: m.eventsTotal,
        dropsTotal: m.dropsTotal,
        childLoopStallsLastMin: m.stallsLastMin,
        lastHeartbeatAt: this.now(),
      }
    } else if (m.type === 'log') {
      this.log.push(m.entry)
      if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
    }
    if (m.type === 'event' || m.type === 'dropped' || m.type === 'permission-open') {
      this.proxy?.handleChildMessage(m)
    }
  }

  start(): HooksGatewayProxy {
    this.spawnChild()
    return this.proxy!
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
    this.health = { ...this.health, state: this.restarts > 0 ? 'restarting' : 'starting' }
    this.appendLog('info', 'child-up', `hooks child forked (restart ${this.restarts})`)
    void this.proxy.start()
    c.onExit(() => this.onChildExit())
  }

  private onChildExit(): void {
    if (this.shuttingDown) return
    this.health = { ...this.health, state: 'crashed', lastError: { message: 'child exited', ts: this.now() } }
    this.appendLog('error', 'crashed', 'hooks child exited unexpectedly')
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
    this.appendLog('warn', 'fallback', 'falling open to in-process gateway')
    this.child?.kill()   // free the port BEFORE the in-process gateway binds (mutual exclusion)
    this.health = { ...this.health, host: 'in-process-fallback', state: 'degraded', restartCount: this.restarts }
    this.proxy?.failOpen()
  }

  shutdown(): void {
    this.shuttingDown = true
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
    try { this.child?.kill() } catch { /* best-effort */ }
  }
}
