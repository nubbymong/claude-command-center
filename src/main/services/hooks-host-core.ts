import { HooksGateway } from '../hooks/hooks-gateway'
import { LoopStallMonitor } from './loop-stall-monitor'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGatewayOptions } from '../hooks/hooks-gateway'
import type { HostTransport } from './service-transport'
import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'

export interface HooksHost {
  _gatewayHasSecret(sid: string): boolean
  /** Drive a single ingest through the real gateway. `body` defaults to a minimal
   *  PostToolUse; pass a custom body to exercise e.g. transcript_path forwarding. */
  _ingestForTest(sid: string, secret: string, body?: Record<string, unknown>): Promise<void>
  _registerResponderForTest(id: string, cb: (decision: string) => void): void
}

/** The minimal gateway surface `createHooksHost` depends on. The default
 *  `createGateway` builds a real `HooksGateway`; tests inject a stub (e.g. one
 *  whose `start()` resolves to a bind failure) to exercise the bind-failed path
 *  deterministically. */
export interface HooksGatewayHostFace {
  registerSessionWithSecret(sid: string, secret: string): void
  unregisterSession(sid: string): void
  start(portOverride?: number): Promise<HooksGatewayStatus>
  stop(): Promise<void>
  setPermissionGateActive(active: boolean): void
  metrics(): { inFlight: number; eventsTotal: number; dropsTotal: number }
  hasSecret(sid: string): boolean
  _handleRequestForTest(args: Parameters<HooksGateway['_handleRequestForTest']>[0]): Promise<{ status: number; body: string }>
  permissionRegister(id: string, cb: (decision: string) => void): void
}

export interface CreateHooksHostOptions {
  healthBeat?: boolean
  /** Injection seam (default builds a real HooksGateway). */
  createGateway?: (o: HooksGatewayOptions) => HooksGatewayHostFace
}

/**
 * Run the HooksGateway inside a child process, bridged to `transport`.
 * - gateway emit (HOOKS_EVENT/HOOKS_DROPPED) -> post digested message to parent
 * - held-open responders live HERE (the socket is here) but their existence is
 *   announced to MAIN (permission-open) and MAIN's decision is routed back
 *   (permission-respond) -- B2: the gateway must NOT import permission-responders.
 * - control messages from parent drive register/unregister/start/stop/setGate.
 */
export function createHooksHost(transport: HostTransport, opts?: CreateHooksHostOptions): HooksHost {
  const localResponders = new Map<string, (decision: string) => void>()

  const createGateway = opts?.createGateway ?? ((o: HooksGatewayOptions) => new HooksGateway(o))
  const gateway = createGateway({
    emit: (channel, payload) => {
      if (channel === IPC.HOOKS_EVENT) {
        transport.post({ type: 'event', entry: payload as HookEvent })
      } else if (channel === IPC.HOOKS_DROPPED) {
        transport.post({ type: 'dropped', sessionId: (payload as { sessionId: string }).sessionId })
      }
    },
    permissionResponders: {
      register: (id, cb) => {
        localResponders.set(id, cb)
        transport.post({ type: 'permission-open', requestId: id, sid: '' })
      },
      deregister: (id) => { localResponders.delete(id) },
    },
    // Logs v2 (Task 8): forward the lifted transcript path to main's binder. The
    // gateway lives in this child process, so the path travels over the transport
    // (like events) rather than calling the binder directly.
    onTranscriptPath: (sid, path) => {
      transport.post({ type: 'transcript-path', sid, path })
    },
  })

  // Forward a small set of operationally-useful child events to the diagnostics
  // ring. Metadata-only (never hook bodies). `Date.now()` is fine here -- this is
  // a real child process, NOT a workflow script.
  const postLog = (level: 'info' | 'warn' | 'error', code: string, message: string) =>
    transport.post({ type: 'log', entry: { ts: Date.now(), serviceId: 'hooks', level, code, message } })

  // Declared ahead of the message handler so the 'stop' case can tear them
  // down explicitly (review nit on 3bddbaa: unref alone leaves the monitor
  // ticking until process exit).
  let loopMonitor: LoopStallMonitor | null = null
  let beat: ReturnType<typeof setInterval> | null = null

  transport.onMessage((msg) => {
    switch (msg.type) {
      case 'register': gateway.registerSessionWithSecret(msg.sid, msg.secret); break
      case 'unregister': gateway.unregisterSession(msg.sid); break
      case 'start':
        void gateway.start(msg.port).then((s) => {
          if (s.listening && s.port != null) {
            transport.post({ type: 'bound', port: s.port, pid: process.pid })
          } else {
            postLog('error', 'bind-failed', s.error ?? 'bind-failed')
            transport.post({ type: 'bind-failed', error: s.error ?? 'bind-failed' })
          }
        })
        break
      case 'stop':
        postLog('info', 'child-stop', 'gateway stop requested')
        loopMonitor?.stop()
        if (beat) clearInterval(beat)
        void gateway.stop()
        break
      case 'setGate': gateway.setPermissionGateActive(msg.active); break
      case 'permission-respond': localResponders.get(msg.requestId)?.(msg.decision); break
      default: break
    }
  })

  if (opts?.healthBeat !== false) {
    // Measure THIS child's event-loop jank with the same monitor + thresholds the
    // main process uses (500ms tick, >250ms late = one stall, 60s window), so the
    // "Jank m/c" pill's child half is real rather than a hardcoded 0.
    loopMonitor = new LoopStallMonitor()
    loopMonitor.start()
    beat = setInterval(() => {
      const m = gateway.metrics()
      transport.post({
        type: 'health',
        inFlight: m.inFlight, eventsTotal: m.eventsTotal, dropsTotal: m.dropsTotal,
        stallsLastMin: loopMonitor!.stallsLastMin(),
      })
    }, 1000)
    if (typeof (beat as { unref?: () => void }).unref === 'function') (beat as { unref: () => void }).unref()
  }

  return {
    _gatewayHasSecret: (sid) => gateway.hasSecret(sid),
    _ingestForTest: (sid, secret, body) => gateway._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/' + sid,
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify(body ?? { hook_event_name: 'PostToolUse', tool_name: 'Glob' }),
    }).then(() => undefined),
    _registerResponderForTest: (id, cb) => gateway.permissionRegister(id, cb),
  }
}
