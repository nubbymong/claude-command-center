import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/ipc-channels'
import { RING_BUFFER_CAP } from '../hooks/hooks-types'
import type { RingBufferEntry } from '../hooks/hooks-types'
import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'
import type { ChildTransport, FromChildMessage } from './service-transport'

export interface HooksGatewayProxyOptions {
  transport: ChildTransport
  defaultPort: number
  emit?: (channel: string, payload: unknown) => void   // to renderer
  selfSubscribe?: boolean   // default true; supervisor passes false and drives handleChildMessage
}

export class HooksGatewayProxy {
  private transport: ChildTransport
  private port: number
  private emit: (channel: string, payload: unknown) => void
  private secrets = new Map<string, string>()
  private buffers = new Map<string, RingBufferEntry[]>()
  private subscribers = new Set<(e: HookEvent) => void>()
  private _status: HooksGatewayStatus = { enabled: true, listening: false, port: null }
  // (the permission-bridge responder map lands in Task 8 alongside the logic that uses it)

  constructor(opts: HooksGatewayProxyOptions) {
    this.transport = opts.transport
    this.port = opts.defaultPort
    this.emit = opts.emit ?? (() => {})
    if (opts.selfSubscribe !== false) this.transport.onMessage((m) => this.onChildMessage(m))
  }

  subscribe(cb: (e: HookEvent) => void): () => void {
    this.subscribers.add(cb); return () => { this.subscribers.delete(cb) }
  }

  /** SYNCHRONOUS: secret minted in main (keeps pty-manager's spawn path sync),
   *  registration fire-and-forget to the child. */
  registerSession(sessionId: string): string {
    const secret = randomUUID()
    this.secrets.set(sessionId, secret)
    this.transport.post({ type: 'register', sid: sessionId, secret })
    return secret
  }

  unregisterSession(sessionId: string): void {
    this.secrets.delete(sessionId); this.buffers.delete(sessionId)
    this.transport.post({ type: 'unregister', sid: sessionId })
    try { this.emit(IPC.HOOKS_SESSION_ENDED, sessionId) } catch { /* webContents destroyed */ }
  }

  getBuffer(sessionId: string): RingBufferEntry[] { return [...(this.buffers.get(sessionId) ?? [])] }
  status(): HooksGatewayStatus { return { ...this._status } }

  /** Test/seam parity with HooksGateway. */
  dispatchForTest(event: HookEvent): void { this.fanOut(event) }

  /** Public entry the supervisor uses when it owns the transport subscription. */
  handleChildMessage(m: FromChildMessage): void { this.onChildMessage(m) }

  private fanOut(event: HookEvent): void {
    for (const cb of [...this.subscribers]) { try { cb(event) } catch { /* bad subscriber */ } }
  }

  private onChildMessage(m: FromChildMessage): void {
    switch (m.type) {
      case 'bound':
        this._status = { enabled: true, listening: true, port: m.port }; break
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
        // Task 8 fills this in (main-side responder registry)
        break
      default: break
    }
  }

  // start/stop/setPermissionGateActive/failOpen/isInProcessFallback/resolvePermission/
  // rebindTransport/replaySecretsTo: Task 8 + Task 10.
}
