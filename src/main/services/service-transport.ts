import type { ServiceLogEntry } from '../../shared/service-health'
import type { HookEvent } from '../../shared/hook-types'

/** main -> child */
export type ToChildMessage =
  | { type: 'register'; sid: string; secret: string }
  | { type: 'unregister'; sid: string }
  | { type: 'start'; port: number }
  | { type: 'stop' }
  | { type: 'setGate'; active: boolean }
  | { type: 'permission-respond'; requestId: string; decision: string }

/** child -> main */
export type FromChildMessage =
  | { type: 'bound'; port: number; pid: number }
  | { type: 'event'; entry: HookEvent }
  | { type: 'dropped'; sessionId: string }
  | { type: 'permission-open'; requestId: string; sid: string }
  | { type: 'health'; inFlight: number; eventsTotal: number; dropsTotal: number; stallsLastMin: number }
  | { type: 'log'; entry: ServiceLogEntry }

/** The transport the main-side proxy/supervisor use to talk to the child. */
export interface ChildTransport {
  post(msg: ToChildMessage): void
  onMessage(handler: (msg: FromChildMessage) => void): void
  kill(): void
}

/** Child-side transport: the host posts FromChildMessage to its parent and
 *  receives ToChildMessage from it (the inverse of ChildTransport). */
export interface HostTransport {
  post(msg: FromChildMessage): void
  onMessage(handler: (msg: ToChildMessage) => void): void
}

/** In-memory fake: `post`/`onMessage` carry main->child; `emitToParent`/`parentMessages`
 *  simulate child->main so tests can drive both directions without a real process. */
export class FakeChildTransport implements ChildTransport {
  private childHandler: ((m: ToChildMessage) => void) | null = null
  private parentHandler: ((m: FromChildMessage) => void) | null = null
  killed = false
  parentMessages: FromChildMessage[] = []

  post(msg: ToChildMessage): void { this.childHandler?.(msg) }
  onMessage(handler: (m: FromChildMessage) => void): void { this.parentHandler = handler }
  kill(): void { this.killed = true }

  // test helpers
  onChild(handler: (m: ToChildMessage) => void): void { this.childHandler = handler }
  emitToParent(msg: FromChildMessage): void { this.parentMessages.push(msg); this.parentHandler?.(msg) }

  /** View this fake from the CHILD side: post() -> parent (emitToParent),
   *  onMessage() receives what main posted (onChild). */
  asHostTransport(): HostTransport {
    return {
      post: (m: FromChildMessage) => this.emitToParent(m),
      onMessage: (h: (m: ToChildMessage) => void) => this.onChild(h),
    }
  }
}
