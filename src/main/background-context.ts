// Tracks whether a Claude session is currently executing in a BACKGROUND
// context — a Task subagent OR a dynamic-workflow agent — rather than the main
// conversation window. While background, the session's model + effort pills in
// the status strip must NOT be repainted with the background agent's values;
// the pills reflect the MAIN window only (user report 2026-07-03: pills flicker
// to the model/effort of subagents and dynamic-workflow agents).
//
// Three independent signals, any of which marks "background":
//   1. Spawn-tool bracket — a subagent or a dynamic workflow is launched by a
//      BLOCKING tool call on the MAIN conversation (Task/Agent for subagents,
//      Workflow for dynamic workflows). That tool's PreToolUse fires on the main
//      transcript BEFORE the background agent runs and its PostToolUse fires
//      AFTER it finishes — both strictly ordered and always delivered to the
//      main endpoint. Bracketing on them is RACE-FREE, which the SubagentStart
//      signal below is not (see #2). This is the primary signal.
//   2. Subagent depth — CC also brackets subagent execution with SubagentStart /
//      SubagentStop hook events. Kept as a backstop, but these are fire-and-
//      forget POSTs that can land AFTER the (blocking) first subagent tool event
//      they are meant to precede, so on their own they let the agent's first
//      effort tick leak. The spawn-tool bracket closes that window.
//   3. Transcript mismatch — CC gives the main conversation a stable
//      transcript_path (captured from the SessionStart hook); a subagent or a
//      workflow agent runs against its own sidechain transcript. A statusline
//      tick or hook event whose transcript differs from the anchored main one
//      is a background context. Catches a dynamic-workflow agent that runs on a
//      sidechain even if no bracket fired.
//
// Fail-open: with none of the signals present (older CC, hooks disabled, or a
// background agent genuinely indistinguishable from the main thread) nothing is
// gated and behaviour is identical to before this module existed.

const depthBySession = new Map<string, number>()
// Open spawn-tool brackets (Task/Agent/Workflow PreToolUse without its
// PostToolUse yet). A COUNT, not a flag, so nested/parallel spawns balance.
const toolDepthBySession = new Map<string, number>()
const mainTranscriptBySession = new Map<string, string>()

/** SessionStart: (re)anchor the main transcript and clear stale depth. CC
 *  re-fires SessionStart on /clear and compaction, so the anchor tracks the
 *  live main transcript rather than going stale. */
export function noteSessionStart(sessionId: string, transcriptPath?: string): void {
  if (!sessionId) return
  depthBySession.delete(sessionId)
  toolDepthBySession.delete(sessionId)
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

/** A background-spawning tool call opened (Task/Agent/Workflow PreToolUse). The
 *  main window is now waiting on a background agent; keep the pills pinned until
 *  the matching PostToolUse. */
export function noteBackgroundToolStart(sessionId: string): void {
  if (!sessionId) return
  toolDepthBySession.set(sessionId, (toolDepthBySession.get(sessionId) ?? 0) + 1)
}

/** A background-spawning tool call closed (its PostToolUse). Back on the main
 *  window once the count returns to zero. */
export function noteBackgroundToolStop(sessionId: string): void {
  if (!sessionId) return
  const next = (toolDepthBySession.get(sessionId) ?? 0) - 1
  if (next > 0) toolDepthBySession.set(sessionId, next)
  else toolDepthBySession.delete(sessionId)
}

/** Turn end (Stop): clear any dangling depth so a missed SubagentStop /
 *  PostToolUse can't freeze the pills into the next turn. Keeps the transcript
 *  anchor. */
export function noteTurnEnd(sessionId: string): void {
  if (!sessionId) return
  depthBySession.delete(sessionId)
  toolDepthBySession.delete(sessionId)
}

/** Session teardown: drop all state for the session. */
export function forgetSession(sessionId: string): void {
  depthBySession.delete(sessionId)
  toolDepthBySession.delete(sessionId)
  mainTranscriptBySession.delete(sessionId)
}

/** True when this session is running a subagent/workflow agent right now (an
 *  open spawn-tool bracket or subagent depth), or when `transcriptPath` (from a
 *  statusline tick or hook event) belongs to a sidechain rather than the
 *  anchored main transcript. */
export function isBackgroundContext(sessionId: string, transcriptPath?: string): boolean {
  if (!sessionId) return false
  if ((toolDepthBySession.get(sessionId) ?? 0) > 0) return true
  if ((depthBySession.get(sessionId) ?? 0) > 0) return true
  const main = mainTranscriptBySession.get(sessionId)
  if (transcriptPath && main && transcriptPath !== main) return true
  return false
}

/** Test seam. */
export function _resetBackgroundContextForTest(): void {
  depthBySession.clear()
  toolDepthBySession.clear()
  mainTranscriptBySession.clear()
}
