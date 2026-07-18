import type { HookEvent } from '../../shared/hook-types'

export interface SessionSecretRecord {
  sessionId: string
  secret: string
  createdAt: number
}

export type RingBufferEntry = HookEvent

// Per-session activity-feed history depth. Each entry's payload is bounded to
// ~8 KiB (see boundPayloadForFeed), so 1000 entries caps worst-case feed memory
// at ~8 MB per session — a hard ceiling versus the previously unbounded payloads.
export const RING_BUFFER_CAP = 1000
export const DEFAULT_HOOKS_PORT = 19334
/** Dev hooks port — a dev instance runs alongside a live production install, so
 *  it must NOT collide with prod's 19334. Mirrors the MCP (19433/19333) and CDP
 *  (9322/9222) dev/prod splits so one prod + one dev coexist without EADDRINUSE. */
export const DEV_HOOKS_PORT = 19434
/** Resolve the default hooks port by build mode. A per-session settings override
 *  (settings.hooksPort) still wins over this. */
export function resolveHooksPort(isPackaged: boolean): number {
  return isPackaged ? DEFAULT_HOOKS_PORT : DEV_HOOKS_PORT
}
export const PORT_RETRY_COUNT = 5
export const PORT_RETRY_OFFSET_MAX = 100
export const REQUEST_BUDGET_MS = 200
