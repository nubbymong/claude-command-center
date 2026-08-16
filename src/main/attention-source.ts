// src/main/attention-source.ts
// Drives session.needsAttention for provider (claude/codex) sessions from hook
// events instead of PTY-output scraping. Replaces the re-fire-prone pulse:
// detection is now discrete hook events, so leaving/returning to a session does
// nothing on its own.
import { getGateway } from './hooks/index'
import { pushAttention } from './ipc/channel-handlers'
import type { HookEvent } from '../shared/hook-types'

// Notification types that mean "Claude is blocked waiting on the USER" — each
// should raise the sidebar attention pulse (#274). The original set was just the
// idle + permission prompts, but Claude Code has since added more user-blocking
// notifications, and a session sitting on ANY of them is the same user-facing
// state: it waits, silently, until the user acts.
//   - permission_prompt      a tool use is awaiting the user's Yes/No
//   - idle_prompt            Claude finished ~60s ago; awaiting the next prompt
//   - agent_needs_input      a (sub)agent escalated a decision to the user — the
//                            case #274 calls out, where a subagent can't self-
//                            approve a command and hands it up
//   - elicitation_dialog     an MCP tool is asking the user a structured question
//   - elicitation_url_dialog ...via a URL / OAuth-style prompt
// Informational notifications (auth_success, agent_completed, elicitation_complete,
// elicitation_response) are NOT here: they don't block the user, so they neither
// raise nor clear — an unknown type is ignored rather than spuriously pulsing.
const ATTENTION_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
])

// true = raise the flasher, false = clear it, null = ignore this event.
export function attentionForEvent(e: HookEvent): boolean | null {
  if (e.event === 'Notification') {
    const t = (e.payload as { notification_type?: string }).notification_type
    return typeof t === 'string' && ATTENTION_NOTIFICATIONS.has(t) ? true : null
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
