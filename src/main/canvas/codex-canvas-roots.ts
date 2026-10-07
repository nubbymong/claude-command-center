// A Codex session's Agent Canvas serving roots (WP2 PR 4, P4.1, row 51).
//
// The same roots, by the same rule, as an interactive Claude session's
// (pty-manager.ts, the Claude branch, after "The Agent Canvas serving
// allowlist rides the same decision"): the CONFIGURED project directory,
// `resolveCwd(options.cwd)`, through `isHomeOrAncestor` and the store's own
// floors, and the worktree CCC designates for the session from that same
// directory and CCC's own session id (ADR-016). Never the folder Codex
// starts in when that is a resumed conversation's (P3.5): a rollout is a file
// the agent can write, so a root taken from it would let the model name its
// own allowlist entry (the adversarial fix of 2026-08-15, recorded at
// ipc/pty-handlers.ts beside noteSessionSpawnForCanvas). The caller passes
// only the configured directory; nothing here can see another.
import { isHomeOrAncestor } from '../path-utils'
import { designatedWorktreeDir } from './canvas-worktree'
import {
  registerCanvasUatRoot, designateCanvasWorktreeRoot, canvasRootRefusalReason, describeCanvasRootRefusal, setCanvasRootRefusal,
} from './canvas-store'
import { logInfo, logWarn } from '../debug-logger'

/** The worktree CCC designates for a Codex session, as for a Claude one:
 *  null for a home (or above) project and for a project that is not a
 *  primary git checkout. Computed before the spawn: its path rides the
 *  session's environment as CCC_SESSION_WORKTREE. */
export function codexDesignatedWorktree(configuredCwd: string, sessionId: string): string | null {
  if (isHomeOrAncestor(configuredCwd)) return null
  try { return designatedWorktreeDir(configuredCwd, sessionId) } catch { return null }
}

/** Register the session's served roots once its process has started: the
 *  configured project directory (refused, and the refusal named, for home
 *  or above and by every store floor) and, independently, the designated
 *  worktree (served once it exists as a real directory). */
export function registerCodexCanvasRoots(sessionId: string, configuredCwd: string, designatedWorktree: string | null): void {
  if (isHomeOrAncestor(configuredCwd)) {
    logWarn(`[pty] canvas serving root NOT registered for Codex session ${sessionId}: the configured project directory resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home).`)
    setCanvasRootRefusal(sessionId, describeCanvasRootRefusal('home-or-ancestor', configuredCwd))
  } else if (!registerCanvasUatRoot(sessionId, configuredCwd)) {
    const reason = canvasRootRefusalReason(sessionId, configuredCwd)
    const explanation = reason ? describeCanvasRootRefusal(reason, configuredCwd) : 'the canvas store refused it.'
    logWarn(`[pty] canvas serving root NOT registered for Codex session ${sessionId} (${reason ?? 'unknown'}): ${explanation}`)
    setCanvasRootRefusal(sessionId, explanation)
  }
  if (designatedWorktree) {
    if (designateCanvasWorktreeRoot(sessionId, designatedWorktree)) {
      logInfo(`[pty] canvas: designated session worktree ${designatedWorktree} for Codex session ${sessionId} (served once it exists)`)
    } else {
      logWarn(`[pty] canvas: designated session worktree ${designatedWorktree} for Codex session ${sessionId} was refused by the canvas store floor.`)
    }
  }
}
