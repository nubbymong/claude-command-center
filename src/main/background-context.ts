// Tracks whether a Claude session is currently executing in a BACKGROUND
// context — a Task subagent OR a dynamic-workflow agent — rather than the main
// conversation window. While background, the session's model + effort pills in
// the status strip must NOT be repainted with the background agent's values;
// the pills reflect the MAIN window only (user report 2026-07-03: pills flicker
// to the model/effort of subagents and dynamic-workflow agents).
//
// Two independent signals, either of which marks "background":
//   1. Subagent depth — CC brackets subagent execution with SubagentStart /
//      SubagentStop hook events. A depth counter handles nested/parallel agents.
//      Reliable for the hook path (these events have tiny, always-delivered
//      payloads). Covers dynamic-workflow agents too when CC brackets them.
//   2. Transcript mismatch — CC gives the main conversation a stable
//      transcript_path (captured from the SessionStart hook); a subagent or a
//      workflow agent runs against its own sidechain transcript. A statusline
//      tick or hook event whose transcript differs from the anchored main one
//      is a background context. This is the signal that catches a
//      dynamic-workflow agent even if it does not fire SubagentStart.
//
// Fail-open: with neither signal present (older CC, hooks disabled, or a
// background agent genuinely indistinguishable from the main thread) nothing is
// gated and behaviour is identical to before this module existed.

const depthBySession = new Map<string, number>()
const mainTranscriptBySession = new Map<string, string>()

/** SessionStart: (re)anchor the main transcript and clear stale depth. CC
 *  re-fires SessionStart on /clear and compaction, so the anchor tracks the
 *  live main transcript rather than going stale. */
export function noteSessionStart(sessionId: string, transcriptPath?: string): void {
  if (!sessionId) return
  depthBySession.delete(sessionId)
  if (transcriptPath) mainTranscriptBySession.set(sessionId, transcriptPath)
}

export function noteSubagentStart(sessionId: string): void {
  if (!sessionId) return
  depthBySession.set(sessionId, (depthBySession.get(sessionId) ?? 0) + 1)
}

export function noteSubagentStop(sessionId: string): void {
  if (!sessionId) return
  const next = (depthBySession.get(sessionId) ?? 0) - 1
  if (next > 0) depthBySession.set(sessionId, next)
  else depthBySession.delete(sessionId)
}

/** Turn end (Stop): clear any dangling depth so a missed SubagentStop can't
 *  freeze the pills into the next turn. Keeps the transcript anchor. */
export function noteTurnEnd(sessionId: string): void {
  if (!sessionId) return
  depthBySession.delete(sessionId)
}

/** Session teardown: drop all state for the session. */
export function forgetSession(sessionId: string): void {
  depthBySession.delete(sessionId)
  mainTranscriptBySession.delete(sessionId)
}

/** True when this session is running a subagent/workflow agent right now, or
 *  when `transcriptPath` (from a statusline tick or hook event) belongs to a
 *  sidechain rather than the anchored main transcript. */
export function isBackgroundContext(sessionId: string, transcriptPath?: string): boolean {
  if (!sessionId) return false
  if ((depthBySession.get(sessionId) ?? 0) > 0) return true
  const main = mainTranscriptBySession.get(sessionId)
  if (transcriptPath && main && transcriptPath !== main) return true
  return false
}

/** Test seam. */
export function _resetBackgroundContextForTest(): void {
  depthBySession.clear()
  mainTranscriptBySession.clear()
}
