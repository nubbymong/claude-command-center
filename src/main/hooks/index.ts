import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'
import type { RingBufferEntry } from './hooks-types'
import { readConfig } from '../config-manager'

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

/**
 * #480: can an EXACT transcript bind ever arrive for a session? Keyed ONLY on the
 * `hooksEnabled` SETTING — not the live `gateway.status().listening`, which blips
 * false during gateway startup / crash-backoff / manual restart. Keying on the
 * transient flag would unlock the cross-prone heuristic fallback in the DEFAULT
 * (hooks-on) config during those windows (adversarial round 2, MAJOR). When hooks
 * are enabled, an authenticated SessionStart hook WILL report the transcript_path
 * once the gateway settles, so the resume paths stay exact-only (no cross).
 *
 * When this is FALSE (hooks disabled by the user) no exact bind can ever arrive,
 * so the resume paths fall back to the heuristic (newest-file) bind AND warn:
 * best-effort resume that can cross if several cards share one repo folder — the
 * deliberate trade for a config that has no authenticated source at all.
 *
 * Edge case (by design): if hooks are ENABLED but the gateway can NEVER bind
 * (e.g. a permanently-taken port), an exact bind never arrives yet this stays
 * TRUE, so such a session gets a FRESH resume rather than a heuristic guess. That
 * fails safe (never a cross) and is preferred over reintroducing the race; after
 * an app restart the durable session_conversation table still recovers any
 * session that achieved an exact bind at least once.
 */
export function isExactBindSourceActive(): boolean {
  return readConfig<{ hooksEnabled?: boolean }>('settings')?.hooksEnabled !== false
}

export { HooksGateway } from './hooks-gateway'
