// Agent Canvas — where a session's isolated git worktree is designated to live.
//
// Session isolation (ADR-012, scripts/session-guard.mjs) puts every agent in
// its own worktree beside the project and blocks writes to the primary
// checkout. The canvas serves only the configured project directory. So an
// agent that isolates itself cannot `canvas_render` a file it wrote (its
// worktree is not a served root) and falls back to inline HTML.
//
// The fix is for CCC — not the agent, not the guard's lease, not git metadata
// — to DECIDE the worktree location, tell the guard (CCC_SESSION_WORKTREE) and
// designate the same path as a pending canvas root
// (canvas-store.designateCanvasWorktreeRoot). Every input here is CCC's own:
// the CONFIGURED project directory (resolveCwd of the session config) and the
// CCC session id. The naming mirrors the guard's own default so a session that
// runs the guard OUTSIDE CCC lands in the same neighbourhood; only the last
// segment differs (CCC's session id rather than Claude Code's, which CCC cannot
// know before the CLI starts). See docs/session-isolation.md and ADR-016.

import * as fs from 'fs'
import * as path from 'path'

/** The worktree base directory the guard uses: `CCC_WT_ROOT` when CCC's own
 *  environment sets it (the guard reads the same variable, inherited from
 *  CCC), else `<parent of the primary checkout>/ccc-wt`. */
export function worktreeBaseDir(primaryCheckout: string, env: NodeJS.ProcessEnv): string {
  const configured = env.CCC_WT_ROOT
  if (typeof configured === 'string' && configured.trim().length > 0 && path.isAbsolute(configured.trim())) {
    return path.resolve(configured.trim())
  }
  return path.join(path.dirname(primaryCheckout), 'ccc-wt')
}

/** The guard names worktrees by the first id segment; CCC ids are 24 hex chars
 *  with no dashes, so take the first 8 (path-safe by the IPC charset guard). */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

export interface DesignateDeps {
  env: NodeJS.ProcessEnv
  /** True when `dir/.git` is a DIRECTORY — a primary checkout. The guard anchors
   *  worktrees to the primary checkout; from a linked worktree (`.git` is a
   *  file) or a non-repo we would only be guessing, and a guess is not a
   *  served root. */
  isPrimaryCheckout: (dir: string) => boolean
}

export const nodeDesignateDeps: DesignateDeps = {
  env: process.env,
  isPrimaryCheckout: (dir) => {
    try {
      return fs.statSync(path.join(dir, '.git')).isDirectory()
    } catch {
      return false
    }
  },
}

/**
 * The directory the session's guard worktree is designated to live in, or null
 * when it cannot be derived (the configured project is not a primary git
 * checkout). Pure given deps: `<worktreeBaseDir>/<shortSessionId>`.
 *
 * Callers pass the CONFIGURED project directory (`resolvedCwd`), never a
 * transcript-derived launch cwd — the same rule the served roots follow.
 */
export function designatedWorktreeDir(
  projectDir: string,
  sessionId: string,
  deps: DesignateDeps = nodeDesignateDeps,
): string | null {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return null
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return null
  const project = path.resolve(projectDir)
  if (!deps.isPrimaryCheckout(project)) return null
  return path.join(worktreeBaseDir(project, deps.env), shortSessionId(sessionId))
}
