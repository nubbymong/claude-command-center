// src/main/attention-source.ts
// Drives session.needsAttention for provider (claude/codex) sessions from hook
// events instead of PTY-output scraping. Replaces the re-fire-prone pulse:
// detection is now discrete hook events, so leaving/returning to a session does
// nothing on its own.
import { getGateway } from './hooks/index'
import { pushAttention } from './ipc/channel-handlers'
import { emitInternal } from './internal-events'
import { codexIdleMarks, codexPendingApprovals, codexOpenCalls, clearCodexIdleAttention, _clearAllCodexIdleAttentionForTest } from './codex-idle-attention'
import type { CodexPendingApproval, CodexOpenCall } from './codex-idle-attention'
import type { HookEvent } from '../shared/hook-types'

// P3.10 round 1 (Q1): pty-manager drops a session's pending idle mark with
// its resources (an exit, a Restart, a Switch).
export { clearCodexIdleAttention }

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

/** A string field of a hook event's payload, or undefined. */
function payloadString(e: HookEvent, key: string): string | undefined {
  const v = (e.payload as Record<string, unknown> | undefined)?.[key]
  return typeof v === 'string' && v ? v : undefined
}

/** P3.10 round 1 (V1): the approval request a Codex session's dot is raised
 *  for, from its PermissionRequest: its turn and tool (Codex's carries no
 *  tool call id; VM payloads of 0.153.4 and 0.155.1). */
function approvalOf(e: HookEvent): { turn?: string; tool?: string } {
  const turn = payloadString(e, 'turn_id')
  const tool = typeof e.toolName === 'string' && e.toolName ? e.toolName : payloadString(e, 'tool_name')
  return { ...(turn ? { turn } : {}), ...(tool ? { tool } : {}) }
}

/** P3.10 round 1 (V1): a PreToolUse may be the call the pending approval is
 *  for: nothing it names says otherwise (the same turn and tool, or a field
 *  either event lacks, as a payload cut down for the feed does). */
function mayBeTheApprovedCall(pending: { turn?: string; tool?: string }, e: HookEvent): boolean {
  const call = approvalOf(e)
  if (pending.turn && call.turn && pending.turn !== call.turn) return false
  if (pending.tool && call.tool && pending.tool !== call.tool) return false
  return true
}

/** Round 2 (R3): an event of another turn than the approval's (both known):
 *  a new turn has started, so the approval is over. */
function ofAnotherTurn(pending: CodexPendingApproval, e: HookEvent): boolean {
  const turn = payloadString(e, 'turn_id')
  return !!pending.turn && !!turn && pending.turn !== turn
}

/** Round 3 (F1): how close before a PermissionRequest its own call's
 *  PreToolUse lands. VM timings: a shell command's pair within 13 ms (either
 *  order), an apply_patch's PreToolUse 131 to 2156 ms before; the model's next
 *  call came about 7 s after the previous one. 3 s holds the slowest pair seen
 *  with room, and stays well under the gap between calls. */
export const CODEX_OWN_PRE_WINDOW_MS = 3000

/** Round 2 (R3): the PermissionRequest came after its own call's PreToolUse:
 *  the session's open call is of the same turn and tool (both known).
 *  Round 3 (F1): and it began within CODEX_OWN_PRE_WINDOW_MS before the
 *  request. An older open call is a previous call's, one whose PostToolUse is
 *  late or never came: the approval then waits for its own PreToolUse. */
function followsItsOwnPre(open: CodexOpenCall | undefined, approval: { turn?: string; tool?: string }, requestAt: number): boolean {
  if (!open || !open.turn || !open.tool || open.turn !== approval.turn || open.tool !== approval.tool) return false
  const gap = requestAt - open.at
  return Number.isFinite(gap) && gap >= 0 && gap <= CODEX_OWN_PRE_WINDOW_MS
}

/** Route one hook event to the attention flasher. Exported for tests.
 *  P3.10 round 1 (V1): Codex runs the app's hooks asynchronously, and fires
 *  PreToolUse and PermissionRequest for one shell command at the same moment,
 *  so the gateway gets them in either order (VM: 3 of 6 rounds on 0.153.4
 *  had PreToolUse second). A PreToolUse never clears the raise for the
 *  approval of its own call: the dot stays up while the approval waits.
 *  Round 2 (R3): when the approval request came first, the next PreToolUse
 *  that may be its call is taken as its own, once, and its tool_use_id kept;
 *  from then on, while the approval waits, only that call's PostToolUse, a
 *  prompt or the turn's end ends it (another call of the turn, running
 *  beside it, clears nothing), and an event of a newer turn ends it too.
 *  Round 4 (P3): when the request came after its own call's PreToolUse, the
 *  approval keeps that call (the open one) in the same way, so only that
 *  call's PostToolUse, a prompt, the turn's end or a newer turn ends it (a
 *  decline ends Codex's turn with no further event: the dot then stays until
 *  the next prompt). Round 3 (F1): "its own call's PreToolUse" is one that
 *  began within CODEX_OWN_PRE_WINDOW_MS before the request; an older open
 *  call is a previous call's, and the request then waits for its own
 *  PreToolUse as when it came first. A turn's end does not clear the dot, as
 *  Claude's does not; it arms the idle mark. */
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
  const sid = e.sessionId
  const clearTimer = opts.clearTimer ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h))
  const pending = codexIdleMarks.get(sid)
  if (pending) { codexIdleMarks.delete(sid); pending.clear(pending.handle) }
  const callId = payloadString(e, 'tool_use_id')
  if (e.event === 'PermissionRequest') {
    const approval = approvalOf(e)
    const open = codexOpenCalls.get(sid)
    if (followsItsOwnPre(open, approval, e.ts)) codexPendingApprovals.set(sid, { ...approval, awaitingOwnPre: false, ...(open?.callId ? { callId: open.callId } : {}) })
    else codexPendingApprovals.set(sid, { ...approval, awaitingOwnPre: true })
    push(sid, true)
    return
  }
  if (e.event === 'PreToolUse') {
    codexOpenCalls.set(sid, { ...approvalOf(e), ...(callId ? { callId } : {}), at: e.ts })
    const approval = codexPendingApprovals.get(sid)
    if (approval && !ofAnotherTurn(approval, e)) {
      if (approval.awaitingOwnPre && mayBeTheApprovedCall(approval, e)) {
        // Its own call's PreToolUse, landing after the approval request: the
        // approval still waits, so the dot stays; its call is this one.
        approval.awaitingOwnPre = false
        if (callId) approval.callId = callId
      }
      // Another call of the same turn while the approval waits: nothing clears.
      return
    }
    codexPendingApprovals.delete(sid)
    push(sid, false)
    return
  }
  if (e.event === 'PostToolUse') {
    const open = codexOpenCalls.get(sid)
    if (open && (!callId || !open.callId || open.callId === callId)) codexOpenCalls.delete(sid)
    const approval = codexPendingApprovals.get(sid)
    if (approval && !ofAnotherTurn(approval, e)) {
      // A call running beside the one waiting finished: the approval still
      // waits. (A PostToolUse naming no call may be the approved one: it clears.)
      if (approval.awaitingOwnPre && callId) return
      if (approval.callId && callId && approval.callId !== callId) return
    }
    codexPendingApprovals.delete(sid)
    push(sid, false)
    return
  }
  // A prompt, a turn's end: the approval is over.
  codexPendingApprovals.delete(sid)
  codexOpenCalls.delete(sid)
  if (v === 'idle') {
    const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
    const h = setTimer(() => {
      if (codexIdleMarks.get(sid)?.handle !== h) return
      codexIdleMarks.delete(sid)
      // Still a Codex session: a closed tab, or one respawned as another kind, is not marked.
      if (opts.isCodexSession?.(sid) !== true) return
      push(sid, true)
      // P3.10 round 1 (S5): the notification rules get what Claude's own
      // idle_prompt gives them (channel-rules notificationRuleContext), so the
      // Attention Pulse rule treats both assistants alike.
      try { emitInternal('attention:idle-prompt', { sessionId: sid }) } catch { /* a rule never stops the mark */ }
    }, CODEX_IDLE_ATTENTION_MS)
    ;(h as { unref?: () => void }).unref?.()
    codexIdleMarks.set(sid, { handle: h, clear: clearTimer })
    return
  }
  push(sid, v)
}

/** Test seam: drop every pending idle mark and approval, and allow a fresh start. */
export function _resetAttentionSourceForTest(): void {
  _clearAllCodexIdleAttentionForTest()
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
