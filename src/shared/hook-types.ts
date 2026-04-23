// Shared types for the HTTP Hooks Gateway. Imported by both main and
// renderer, so this file must stay free of Node- or DOM-specific imports.

export type HookEventKind =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'SessionStart'
  | 'Stop'
  | 'PreCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'StopFailure'

export interface HookEvent {
  sessionId: string
  event: HookEventKind | string
  toolName?: string
  summary?: string
  payload: Record<string, unknown>
  ts: number
}

export interface HooksGatewayStatus {
  enabled: boolean
  listening: boolean
  port: number | null
  error?: string
}

export interface HooksToggleRequest {
  enabled: boolean
}

export interface HooksGetBufferRequest {
  sessionId: string
}
