// Shared types for the HTTP Hooks Gateway. Imported by both main and
// renderer, so this file must stay free of Node- or DOM-specific imports.

export const HOOK_EVENT_KINDS = [
  'PreToolUse', 'PostToolUse', 'Notification', 'SessionStart', 'Stop',
  'PreCompact', 'SubagentStart', 'SubagentStop', 'StopFailure',
  'PermissionRequest', 'FileChanged',
] as const
export type HookEventKind = typeof HOOK_EVENT_KINDS[number]

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
