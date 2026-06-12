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
export const PORT_RETRY_COUNT = 5
export const PORT_RETRY_OFFSET_MAX = 100
export const REQUEST_BUDGET_MS = 200
