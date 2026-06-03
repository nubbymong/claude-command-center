import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'
import type { RingBufferEntry } from './hooks-types'

/** The gateway surface consumers use via getGateway(). Implemented by both the
 *  in-process HooksGateway and the out-of-process HooksGatewayProxy, so either can
 *  back the singleton without casts. */
export interface HooksGatewayLike {
  registerSession(sessionId: string): string
  unregisterSession(sessionId: string): void
  getBuffer(sessionId: string): RingBufferEntry[]
  status(): HooksGatewayStatus
  start(): Promise<HooksGatewayStatus>
  stop(): Promise<void>
  setPermissionGateActive(active: boolean): void
  subscribe(cb: (e: HookEvent) => void): () => void
}

let singleton: HooksGatewayLike | null = null

export function setGateway(gw: HooksGatewayLike): void {
  singleton = gw
}

export function getGateway(): HooksGatewayLike | null {
  return singleton
}

export { HooksGateway } from './hooks-gateway'
