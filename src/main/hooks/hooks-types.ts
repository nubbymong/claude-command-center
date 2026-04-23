import type { HookEvent } from '../../shared/hook-types'

export interface SessionSecretRecord {
  sessionId: string
  secret: string
  createdAt: number
}

export type RingBufferEntry = HookEvent

export const RING_BUFFER_CAP = 200
export const DEFAULT_HOOKS_PORT = 19334
export const PORT_RETRY_COUNT = 5
export const PORT_RETRY_OFFSET_MAX = 100
export const REQUEST_BUDGET_MS = 200
