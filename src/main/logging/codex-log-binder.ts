/**
 * codex-log-binder.ts: a Codex session's rollout claims become its run's
 * transcript binds (P3.12, rows 31 and 32), as Claude's transcript binder turns
 * its exact sources (hooks, statusline) into binds.
 *
 * Codex has none of Claude's sources: the session's own rollout watcher (P3.5,
 * P3.10) is the claim. It is told, through pty-manager, the rollout the
 * watcher claims (a path it has already checked is a plain rollout file of the
 * session's own realm, never a link) and when that claim is let go. Nothing
 * else reaches it: a hook's transcript path is claimed only through the
 * watcher's own check. So one realm's rollouts are only ever indexed under a
 * session of that realm.
 *
 * Per session:
 *  - a claim is held from the launch (beginLaunch) until the run is recorded
 *    (startRun): a resume claims at once, before pty-manager's runStart, and a
 *    Restart reuses the session id, so a bind sent earlier would land on the
 *    previous run;
 *  - bound 'exact' when the conversation is known (a resume by id, a pick, the
 *    session's own hook) and 'heuristic' when it was taken by folder and time;
 *    the hook confirming an inferred claim re-binds it exact, never the other
 *    way; a new claim is a new bind (the worker rotates to it);
 *  - a claim let go retires its tail (unbindTranscript): the session is no
 *    longer on that conversation, and it may be another session's;
 *  - a conversation another tab holds (shared) is not indexed by this one, as
 *    Claude's binder refuses a conversation another live session holds (#480);
 *  - no run recorded (logging off for the session, or globally): nothing is
 *    bound, but the claim is still known for the name file.
 *
 * The name file (#536, row 32): on an exact claim the name remembered for the
 * session (a rename made before its conversation was known) is written next to
 * the rollout and forgotten, exactly Claude's onExactBind; exactRollout is what
 * a rename writes against, never an inferred or shared claim.
 *
 * Pure: every effect is an injected dep, and a dep that throws never breaks a
 * claim. No Electron import; no default export.
 */

/** What a session's watcher reports: the rollout it claims, or null when it
 *  lets its claim go. */
export interface CodexRolloutReport {
  path: string
  /** The realm's sessions folder the watcher claimed it in (the name file
   *  write checks the folders from there down). */
  sessionsDir: string
  /** The conversation is known (a resume by id, a pick, its own hook). */
  exact: boolean
  /** Another session holds this rollout; this one reads it beside it. */
  shared: boolean
  /** P3.12 round 1 (A1): the claimed file's identity (dev:ino), when the
   *  watcher recorded one; the worker reads only that file at the path. */
  identity?: string
}

export interface CodexLogBinderDeps {
  supervisor: {
    bindTranscript(sessionId: string, path: string, confidence: 'exact' | 'heuristic', sourceVersion?: string, sourceFormat?: 'claude-jsonl' | 'codex-rollout', sourceIdentity?: string): void
    unbindTranscript(sessionId: string, path: string): void
  }
  /** Write (or, for a blank name, clear) the name file next to a rollout of
   *  the realm whose sessions folder is `sessionsDir`. */
  writeName: (rolloutPath: string, sessionsDir: string, name: string) => void
  /** The name remembered for the session before its conversation was known. */
  rememberedName: (sessionId: string) => string | null
  forgetName: (sessionId: string) => void
  /** Paths-only diagnostics. */
  log?: (msg: string) => void
}

export interface CodexLogBinder {
  /** A launch of the session begins: whatever an earlier launch claimed is
   *  not this run's. */
  beginLaunch(sessionId: string): void
  /** The session's run was recorded (registered) or not (logging off). */
  startRun(sessionId: string, registered: boolean): void
  /** The session's watcher claimed a rollout, confirmed one, or (null) let its
   *  claim go. */
  noteRollout(sessionId: string, rollout: CodexRolloutReport | null): void
  /** The session's process ended. */
  endRun(sessionId: string): void
  /** P3.12 round 1 (V1): the logging switch was turned off for a running
   *  session: nothing it claims from now on is bound (its run was ended);
   *  its claims still carry the name file. */
  stopIndexing(sessionId: string): void
  /** The rollout the session is exactly on (and its realm's sessions
   *  folder), for the name file; else null. */
  exactRollout(sessionId: string): { path: string; sessionsDir: string } | null
  /** Whether this binder has the session (a Codex session it was told of). */
  knows(sessionId: string): boolean
}

/** The most sessions held at once; the oldest goes first. */
const MAX_SESSIONS = 512

interface SessionState {
  running: boolean
  registered: boolean
  claim: { path: string; sessionsDir: string; exact: boolean; identity?: string } | null
  bound: { path: string; exact: boolean; identity?: string } | null
}

export function makeCodexLogBinder(deps: CodexLogBinderDeps): CodexLogBinder {
  const sessions = new Map<string, SessionState>()
  const log = deps.log ?? (() => { /* no-op */ })

  function fresh(sessionId: string): SessionState {
    const s: SessionState = { running: false, registered: false, claim: null, bound: null }
    sessions.delete(sessionId)
    sessions.set(sessionId, s)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
    return s
  }

  const stateOf = (sessionId: string): SessionState => sessions.get(sessionId) ?? fresh(sessionId)

  function unbind(sessionId: string, s: SessionState): void {
    if (!s.bound) return
    const path = s.bound.path
    s.bound = null
    try { deps.supervisor.unbindTranscript(sessionId, path) } catch { /* the index is best-effort */ }
  }

  function sync(sessionId: string, s: SessionState): void {
    if (!s.running || !s.registered || !s.claim) return
    const claim = s.claim
    // Nothing new: the same file at the same rollout path, known no better
    // than it was bound.
    if (s.bound && s.bound.path === claim.path && s.bound.identity === claim.identity && (s.bound.exact || !claim.exact)) return
    s.bound = { path: claim.path, exact: claim.exact, ...(claim.identity ? { identity: claim.identity } : {}) }
    const confidence = claim.exact ? 'exact' : 'heuristic'
    try {
      if (claim.identity) deps.supervisor.bindTranscript(sessionId, claim.path, confidence, undefined, 'codex-rollout', claim.identity)
      else deps.supervisor.bindTranscript(sessionId, claim.path, confidence, undefined, 'codex-rollout')
    } catch { /* the index is best-effort */ }
  }

  return {
    beginLaunch(sessionId) {
      fresh(sessionId)
    },

    startRun(sessionId, registered) {
      const s = stateOf(sessionId)
      s.running = true
      s.registered = registered
      sync(sessionId, s)
    },

    noteRollout(sessionId, rollout) {
      const s = stateOf(sessionId)
      if (!rollout || rollout.shared) {
        if (rollout?.shared) log(`[codex-logs] ${sessionId}: its conversation is held by another tab; not indexed here`)
        s.claim = null
        unbind(sessionId, s)
        return
      }
      s.claim = {
        path: rollout.path,
        sessionsDir: rollout.sessionsDir,
        exact: rollout.exact === true,
        ...(typeof rollout.identity === 'string' && rollout.identity ? { identity: rollout.identity } : {}),
      }
      if (s.claim.exact) {
        // #536 for Codex: a name set before the conversation was known.
        try {
          const name = deps.rememberedName(sessionId)
          if (name) deps.writeName(rollout.path, rollout.sessionsDir, name)
        } catch { /* a name is never worth a claim */ }
        try { deps.forgetName(sessionId) } catch { /* best-effort */ }
      }
      sync(sessionId, s)
    },

    endRun(sessionId) {
      sessions.delete(sessionId)
    },

    stopIndexing(sessionId) {
      const s = sessions.get(sessionId)
      if (!s) return
      // The run was ended (the worker drained and retired its tails).
      s.registered = false
      s.bound = null
    },

    exactRollout(sessionId) {
      const claim = sessions.get(sessionId)?.claim
      return claim && claim.exact ? { path: claim.path, sessionsDir: claim.sessionsDir } : null
    },

    knows(sessionId) {
      return sessions.has(sessionId)
    },
  }
}

/** The binder the logging service made at boot; null while logging is off
 *  (no worker), as getTranscriptBinder is. Kept here, beside the factory, so
 *  pty-manager and the logs IPC reach it without the logging service. */
let current: CodexLogBinder | null = null

export function getCodexLogBinder(): CodexLogBinder | null {
  return current
}

/** logging-service: set at initLogging, cleared at shutdown (tests too). */
export function setCodexLogBinder(binder: CodexLogBinder | null): void {
  current = binder
}
