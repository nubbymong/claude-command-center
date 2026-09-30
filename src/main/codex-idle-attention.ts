// src/main/codex-idle-attention.ts
// P3.10 (row 47): what the attention source keeps per Codex session between
// its hook events -- the pending idle mark a turn's end arms, and (round 1,
// V1) the approval request the dot is raised for. A leaf module (no imports),
// so pty-manager can drop both with the session's resources (round 1, Q1)
// without loading the attention source's IPC side.

/** One pending idle mark per Codex session: the timer, and how to stop it. */
export interface CodexIdleMark {
  handle: ReturnType<typeof setTimeout>
  clear: (h: ReturnType<typeof setTimeout>) => void
}
export const codexIdleMarks = new Map<string, CodexIdleMark>()

/** The approval request a Codex session's dot is raised for: its turn and
 *  tool, as the PermissionRequest named them (Codex's carries no tool call
 *  id), when it did. Round 2 (R3): `awaitingOwnPre` while the request came
 *  before its own call's PreToolUse (which is then taken as its own, once);
 *  `callId`, that PreToolUse's tool_use_id once taken, or (round 4, P3) the
 *  open call's when the request came after its PreToolUse. */
export interface CodexPendingApproval {
  turn?: string
  tool?: string
  awaitingOwnPre: boolean
  callId?: string
}
export const codexPendingApprovals = new Map<string, CodexPendingApproval>()

/** Round 2 (R3): each Codex session's latest PreToolUse whose PostToolUse
 *  has not come yet: its turn, tool and tool_use_id. Round 3 (F1): and when
 *  the gateway received it (the event's ts). */
export interface CodexOpenCall {
  turn?: string
  tool?: string
  callId?: string
  at: number
}
export const codexOpenCalls = new Map<string, CodexOpenCall>()

/** Drop the session's pending idle mark (its timer stopped) and its pending
 *  approval: its run ended, restarted or moved to another account. */
export function clearCodexIdleAttention(sessionId: string): void {
  const mark = codexIdleMarks.get(sessionId)
  if (mark) {
    codexIdleMarks.delete(sessionId)
    try { mark.clear(mark.handle) } catch { /* already gone */ }
  }
  codexPendingApprovals.delete(sessionId)
  codexOpenCalls.delete(sessionId)
}

/** Test seam: drop everything. */
export function _clearAllCodexIdleAttentionForTest(): void {
  for (const id of [...codexIdleMarks.keys()]) clearCodexIdleAttention(id)
  codexPendingApprovals.clear()
  codexOpenCalls.clear()
}
