// src/main/attention-source.ts
// Drives session.needsAttention for provider (claude/codex) sessions from hook
// events instead of PTY-output scraping. Replaces the re-fire-prone pulse:
// detection is now discrete hook events, so leaving/returning to a session does
// nothing on its own.
import { getGateway } from './hooks/index'
import { pushAttention } from './ipc/channel-handlers'
import type { HookEvent } from '../shared/hook-types'

// true = raise the flasher, false = clear it, null = ignore this event.
export function attentionForEvent(e: HookEvent): boolean | null {
  if (e.event === 'Notification') {
    const t = (e.payload as { notification_type?: string }).notification_type
    return t === 'idle_prompt' || t === 'permission_prompt' ? true : null
  }
  if (e.event === 'UserPromptSubmit' || e.event === 'PreToolUse' || e.event === 'PostToolUse') return false
  return null
}

let started = false
export function startAttentionSource(): void {
  if (started) return
  started = true
  const gw = getGateway()
  if (!gw) return
  gw.subscribe((e) => {
    const v = attentionForEvent(e)
    if (v !== null) pushAttention(e.sessionId, v)
  })
}
