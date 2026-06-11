import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/ipc-channels'
import { RING_BUFFER_CAP } from '../hooks/hooks-types'
import { HooksGateway } from '../hooks/hooks-gateway'
import type { RingBufferEntry } from '../hooks/hooks-types'
import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'
import type { HooksGatewayLike } from '../hooks'
import type { ChildTransport, FromChildMessage } from './service-transport'

export interface HooksGatewayProxyOptions {
  transport: ChildTransport
  defaultPort: number
  emit?: (channel: string, payload: unknown) => void   // to renderer
  selfSubscribe?: boolean   // default true; supervisor passes false and drives handleChildMessage
  // Logs v2 (Task 8): handed to the in-process gateway on fail-open so transcript
  // discovery via hooks keeps working when the child path is gone. In utility-process
  // mode the child gateway forwards the path over the transport instead.
  onTranscriptPath?: (sessionId: string, path: string) => void
}

// `implements HooksGatewayLike` enforces the drop-in contract at compile time: if a
// method is added to the consumed gateway surface, the proxy must implement it too.
export class HooksGatewayProxy implements HooksGatewayLike {
  private transport: ChildTransport
  private port: number
  private emit: (channel: string, payload: unknown) => void
  private onTranscriptPath?: (sessionId: string, path: string) => void
  private secrets = new Map<string, string>()
  private buffers = new Map<string, RingBufferEntry[]>()
  private subscribers = new Set<(e: HookEvent) => void>()
  private _status: HooksGatewayStatus = { enabled: true, listening: false, port: null }
  // Fail-open: when set, the gateway runs IN-PROCESS (today's exact HooksGateway)
  // and every consumer method delegates to it so the proxy stays a faithful drop-in.
  private inProcess: HooksGateway | null = null
  private inProcessReady: Promise<unknown> | null = null
  // Permission bridge: ids of child-opened requests awaiting a main-side decision.
  // Presence-tracking only — the actual held-open responder lives in the child;
  // resolvePermission routes the decision back over the transport.
  private openPermissionRequests = new Set<string>()
  // start() (utility mode) returns only once the child announces `bound`, so the
  // hooks toggle persists the REAL listening status (not a premature listening:false).
  // An UNREF'd timeout fallback guarantees a bind failure can't hang the toggle.
  private static BOUND_WAIT_MS = 4000
  private boundWaiters: Array<{ resolve: (s: HooksGatewayStatus) => void; timer: ReturnType<typeof setTimeout> }> = []

  private resolveBoundWaiters(): void {
    const waiters = this.boundWaiters.splice(0)
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(this.status()) }
  }

  constructor(opts: HooksGatewayProxyOptions) {
    this.transport = opts.transport
    this.port = opts.defaultPort
    this.emit = opts.emit ?? (() => {})
    this.onTranscriptPath = opts.onTranscriptPath
    if (opts.selfSubscribe !== false) this.transport.onMessage((m) => this.onChildMessage(m))
  }

  subscribe(cb: (e: HookEvent) => void): () => void {
    // After fail-open the in-process gateway owns fan-out, so a new subscriber goes
    // straight there. this.subscribers stays dormant once inProcess is set (the
    // pre-failOpen subscribers were already copied into the gateway by failOpen()).
    if (this.inProcess) return this.inProcess.subscribe(cb)
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  /** SYNCHRONOUS: secret minted in main (keeps pty-manager's spawn path sync),
   *  registration fire-and-forget to the child. After fail-open it delegates to
   *  the in-process gateway (still synchronous) instead of posting to a dead child. */
  registerSession(sessionId: string): string {
    if (this.inProcess) return this.inProcess.registerSession(sessionId)
    const secret = randomUUID()
    this.secrets.set(sessionId, secret)
    this.transport.post({ type: 'register', sid: sessionId, secret })
    return secret
  }

  unregisterSession(sessionId: string): void {
    if (this.inProcess) { this.inProcess.unregisterSession(sessionId); return }
    this.secrets.delete(sessionId); this.buffers.delete(sessionId)
    this.transport.post({ type: 'unregister', sid: sessionId })
    try { this.emit(IPC.HOOKS_SESSION_ENDED, sessionId) } catch { /* webContents destroyed */ }
  }

  getBuffer(sessionId: string): RingBufferEntry[] {
    if (this.inProcess) return this.inProcess.getBuffer(sessionId)
    return [...(this.buffers.get(sessionId) ?? [])]
  }

  status(): HooksGatewayStatus {
    if (this.inProcess) return this.inProcess.status()
    return { ...this._status }
  }

  /** Test/seam parity with HooksGateway. After fail-open the in-process gateway
   *  owns fan-out, so delegate there (matches the other read-path delegations). */
  dispatchForTest(event: HookEvent): void {
    if (this.inProcess) { this.inProcess.dispatchForTest(event); return }
    this.fanOut(event)
  }

  /** Public entry the supervisor uses when it owns the transport subscription. */
  handleChildMessage(m: FromChildMessage): void { this.onChildMessage(m) }

  private fanOut(event: HookEvent): void {
    for (const cb of [...this.subscribers]) { try { cb(event) } catch { /* bad subscriber */ } }
  }

  private onChildMessage(m: FromChildMessage): void {
    switch (m.type) {
      case 'bound':
        this._status = { enabled: true, listening: true, port: m.port }
        try { this.emit(IPC.HOOKS_STATUS, { ...this._status }) } catch { /* destroyed */ }
        this.resolveBoundWaiters()
        break
      case 'event': {
        const entry = m.entry
        const buf = this.buffers.get(entry.sessionId) ?? []
        buf.push(entry as RingBufferEntry)
        if (buf.length > RING_BUFFER_CAP) buf.splice(0, buf.length - RING_BUFFER_CAP)
        this.buffers.set(entry.sessionId, buf)
        this.fanOut(entry)
        try { this.emit(IPC.HOOKS_EVENT, entry) } catch { /* destroyed */ }
        break
      }
      case 'dropped':
        // The child's gateway latches HOOKS_DROPPED once per session (overflowLatched),
        // so we receive at most one 'dropped' per session and don't need a local latch.
        try { this.emit(IPC.HOOKS_DROPPED, { sessionId: m.sessionId }) } catch { /* destroyed */ }
        break
      case 'permission-open':
        // Record the open request so a later resolvePermission(requestId, ...)
        // is meaningful (we route the decision back to the child).
        this.openPermissionRequests.add(m.requestId)
        break
      case 'transcript-path':
        // Logs v2 (Task 8): only reached on the self-subscribe path. In production
        // the supervisor owns the subscription and routes this itself; this keeps
        // a self-subscribing proxy (tests / non-supervised) feeding the binder too.
        try { this.onTranscriptPath?.(m.sid, m.path) } catch { /* sink must not break routing */ }
        break
      default: break
    }
  }

  /** Enable the gateway. Utility-process mode posts `start` to the child;
   *  after fail-open it drives the in-process gateway directly. */
  async start(): Promise<HooksGatewayStatus> {
    if (this.inProcess) { await this.inProcessReady; return this.inProcess.start() }
    this.transport.post({ type: 'start', port: this.port })
    this._status = { ...this._status, enabled: true }
    // Already listening (e.g. a re-enable). Safe because the supervisor resets
    // listening:false via rebindTransport() on every child restart, so a dead
    // child can't leave this stale-true — and we already posted `start` above, so
    // a live child re-receives it regardless.
    if (this._status.listening) return this.status()
    return new Promise<HooksGatewayStatus>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.boundWaiters = this.boundWaiters.filter((w) => w !== waiter)
          resolve(this.status())   // timed out — return whatever we have
        }, HooksGatewayProxy.BOUND_WAIT_MS),
      }
      if (typeof (waiter.timer as { unref?: () => void }).unref === 'function') (waiter.timer as { unref: () => void }).unref()
      this.boundWaiters.push(waiter)
    })
  }

  /** Disable the gateway. Awaits the in-process bind first (if fail-open) so a
   *  start->stop race can't leak the listening socket. */
  async stop(): Promise<void> {
    if (this.inProcess) { await this.inProcessReady; await this.inProcess.stop(); return }
    this.transport.post({ type: 'stop' })
    this._status = { enabled: false, listening: false, port: null }
    this.resolveBoundWaiters()   // a start()->stop() race must not wait out the 4s bound fallback
  }

  setPermissionGateActive(active: boolean): void {
    if (this.inProcess) { this.inProcess.setPermissionGateActive(active); return }
    this.transport.post({ type: 'setGate', active })
  }

  isInProcessFallback(): boolean { return this.inProcess !== null }

  /** Tear down the child path and run the gateway in-process (today's exact code).
   *  Replays known secrets + current subscribers so live sessions keep working.
   *  PRECONDITION: the supervisor has already killed the child (no double bind). */
  failOpen(): void {
    if (this.inProcess) return
    const gw = new HooksGateway({ defaultPort: this.port, emit: this.emit, onTranscriptPath: this.onTranscriptPath })
    for (const [sid, secret] of this.secrets) gw.registerSessionWithSecret(sid, secret)
    for (const cb of this.subscribers) gw.subscribe(cb)
    this.inProcess = gw
    // Tracked so stop() can await it (no socket leak / race). Draining the bound
    // waiters only AFTER the in-process gateway binds lets a start() awaited across
    // the fail-open transition resolve with the real listening status (via
    // status()->inProcess) instead of waiting out the 4s bound fallback.
    this.inProcessReady = gw.start().then((s) => { this.resolveBoundWaiters(); return s })
  }

  /** Renderer Allow/Deny path. In-process: the module responder registry already
   *  handles it (no-op here). Utility-process: route the decision back to the child. */
  resolvePermission(requestId: string, decision: string): void {
    this.openPermissionRequests.delete(requestId)   // clear regardless of host
    if (this.inProcess) return   // in-process: the module responder registry already resolved it
    this.transport.post({ type: 'permission-respond', requestId, decision })
  }

  // Supervisor helpers (used in Task 10):
  rebindTransport(t: ChildTransport): void {
    this.transport = t
    this._status = { ...this._status, listening: false }
    this.resolveBoundWaiters()   // drop any waiter (and its timer) tied to the previous child
  }

  // Precondition: utility-process mode only (called on child restart, before any
  // fail-open). this.secrets is the source of truth there; after failOpen() it goes
  // stale because registerSession delegates to the in-process gateway.
  replaySecretsTo(t: ChildTransport): void {
    for (const [sid, secret] of this.secrets) t.post({ type: 'register', sid, secret })
  }

  /** Test-only: reflects whichever store currently owns the session secret. */
  hasSecretForTest(sid: string): boolean {
    return this.inProcess ? this.inProcess.hasSecret(sid) : this.secrets.has(sid)
  }
}
