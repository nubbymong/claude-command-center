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

/**
 * P3.10 (row 47): how long after a Codex turn ends, with nothing new sent,
 * the session is marked as waiting for the user -- the wait Claude Code's
 * own idle_prompt notification makes ("Claude finished ~60s ago; awaiting
 * the next prompt"). Codex has no such notification; its Stop hook marks
 * the turn's end, so the app keeps the same wait.
 */
export const CODEX_IDLE_ATTENTION_MS = 60_000

/**
 * P3.10 (row 47): Codex's own hook events (P3.1 evidence, answer 4), mapped as
 * Claude Code's are:
 *  - PermissionRequest: Codex asks the user to approve something (Claude's
 *    permission_prompt): raise;
 *  - Stop: the turn ended; the session waits for the next prompt, marked
 *    after CODEX_IDLE_ATTENTION_MS as Claude's idle_prompt is ('idle');
 *  - UserPromptSubmit, PreToolUse, PostToolUse: the user or the agent is
 *    acting: clear, as for Claude;
 *  - anything else: ignored.
 */
export function codexAttentionForEvent(e: HookEvent): boolean | 'idle' | null {
  if (e.event === 'PermissionRequest') return true
  if (e.event === 'Stop') return 'idle'
  if (e.event === 'UserPromptSubmit' || e.event === 'PreToolUse' || e.event === 'PostToolUse') return false
  return null
}

export interface AttentionSourceOptions {
  /** Whether a session runs Codex (its events are Codex's, mapped by
   *  codexAttentionForEvent). Absent: every event maps as Claude's. */
  isCodexSession?: (sessionId: string) => boolean
  /** Test seams. */
  push?: (sessionId: string, needsAttention: boolean) => void
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

/** One pending idle mark per Codex session (a later event drops it). */
const codexIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Route one hook event to the attention flasher. Exported for tests. */
export function routeAttentionEvent(e: HookEvent, opts: AttentionSourceOptions = {}): void {
  const push = opts.push ?? pushAttention
  const isCodex = opts.isCodexSession?.(e.sessionId) === true
  if (!isCodex) {
    const v = attentionForEvent(e)
    if (v !== null) push(e.sessionId, v)
    return
  }
  const v = codexAttentionForEvent(e)
  if (v === null) return
  const clearTimer = opts.clearTimer ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h))
  const pending = codexIdleTimers.get(e.sessionId)
  if (pending) { clearTimer(pending); codexIdleTimers.delete(e.sessionId) }
  if (v === 'idle') {
    const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
    const sid = e.sessionId
    const h = setTimer(() => {
      if (codexIdleTimers.get(sid) !== h) return
      codexIdleTimers.delete(sid)
      // Still a Codex session: a closed tab, or one respawned as another kind, is not marked.
      if (opts.isCodexSession?.(sid) === true) push(sid, true)
    }, CODEX_IDLE_ATTENTION_MS)
    ;(h as { unref?: () => void }).unref?.()
    codexIdleTimers.set(sid, h)
    return
  }
  push(e.sessionId, v)
}

/** Test seam: drop every pending idle mark, and allow a fresh start. */
export function _resetAttentionSourceForTest(): void {
  for (const h of codexIdleTimers.values()) clearTimeout(h)
  codexIdleTimers.clear()
  started = false
}

let started = false
export function startAttentionSource(opts: AttentionSourceOptions = {}): void {
  if (started) return
  started = true
  const gw = getGateway()
  if (!gw) return
  gw.subscribe((e) => routeAttentionEvent(e, opts))
}
