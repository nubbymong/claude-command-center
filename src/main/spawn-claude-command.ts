/**
 * spawn-claude-command.ts — pure builder for the Claude launch command string.
 *
 * Extracted verbatim from pty-manager.ts's Claude branch (the shell command
 * written into the PTY after spawn) so it can be unit-tested WITHOUT node-pty /
 * Electron. No default export (project convention). No side effects.
 *
 * Behaviour contract:
 *   - When `resumeUuid` is ABSENT the produced string is BYTE-IDENTICAL to the
 *     pre-refactor inline construction (picker / picker-fallback / direct).
 *   - When `resumeUuid` is PRESENT the resume-picker branch is BYPASSED and the
 *     command launches Claude directly with `--resume <uuid>` FIRST, before
 *     --settings / --mcp-config / --agents etc. (mirrors the ordering in
 *     scripts/resume-picker.js:299 — the resume verb must come first).
 *
 * The cwd-override decision (whether a resume target exists + all the fail-open
 * existence checks) lives in the CALLER (pty-manager). This function only knows
 * "given a uuid (or not), produce the command".
 */

import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import { UUID_RE, mangleCwdToProjectDir } from './logging/transcript-discovery'

export interface BuildClaudeLaunchCommandOptions {
  /** 'win32' produces a PowerShell command; anything else produces a POSIX sh command. */
  platform: 'win32' | 'posix' | string
  /** The (already account/worktree-resolved) directory to cd into before launch. */
  cwd: string
  /** Resolved claude binary path/command (resolveClaudeForPty().cmd). */
  claudeBin: string
  /** Pre-built extra flag string (e.g. ` --effort high --settings '...' --mcp-config '...'`). */
  extraFlags: string
  /** Pre-built --agents flag string (empty when no agents). */
  agentsFlag: string
  /** Whether the resume-picker branch would normally run (restored sessions). */
  useResumePicker: boolean
  /** Resolved resume-picker.js path, or null when not deployed. */
  pickerScript: string | null
  /**
   * When set, BYPASS the picker and launch `claude --resume <uuid>` directly.
   * The caller has already validated the uuid + transcript/companion/cwd
   * existence; this builder trusts it. Absent => golden no-resume behaviour.
   */
  resumeUuid?: string
}

/**
 * Escape a path for single-quoting in the target shell.
 *   - win32 (PowerShell): double the single quotes.
 *   - posix (sh): close-quote, backslash-escape, reopen-quote.
 */
function escapeForCwdQuote(p: string, isWin32: boolean): string {
  return isWin32 ? p.replace(/'/g, "''") : p.replace(/'/g, "'\\''")
}

// ---------------------------------------------------------------------------
// resolveResumeLaunch — pure resume-launch decision (T8b, bug #5 review)
// ---------------------------------------------------------------------------

/** A captured resume target: the conversation uuid + the cwd it ran in. */
export interface ResumeTarget {
  uuid: string
  cwd: string
}

/**
 * Injectable deps for {@link resolveResumeLaunch}. Production passes thin
 * wrappers over node fs/os; tests pass in-memory fakes. Keeping this pure makes
 * the CRITICAL deleted-worktree gate fully unit-testable WITHOUT touching disk.
 */
export interface ResolveResumeLaunchDeps {
  existsSync: (p: string) => boolean
  /** Must throw (or be guarded by the caller) when the path does not exist. */
  statSync: (p: string) => { isDirectory: () => boolean }
  homedir: () => string
  mangleCwdToProjectDir: (cwd: string) => string
  /** Canonical `~/.claude/projects` root (homedir-based; per-account homes are junctions to it). */
  projectsRoot: string
  /**
   * Best-effort: ensure the `<projectDir>/<uuid>/` companion dir exists so the
   * CLI can resume a DIRECT-WORK conversation that never spawned a
   * subagent/workflow (and therefore has no companion dir of its own). Called
   * AFTER the transcript gate passes; its failure must NOT drop the resume (the
   * transcript is real — we still launch `--resume`). Side-effecting; injected so
   * the decision logic stays unit-testable. Production wraps companion-dir.ts.
   */
  ensureCompanionDir: (projectDir: string, uuid: string) => void
}

/**
 * Decide whether to launch `claude --resume <uuid>` with an overridden cwd.
 *
 * Encapsulates the path/cwd existence gate (extracted from the old inline block
 * in pty-manager.spawnPty). The provider / discoveryOn gating stays in the
 * caller — this function is concerned ONLY with paths.
 *
 * CRITICAL (Fix 1 — deleted-worktree regression guard): the gate stats the
 * RAW captured cwd directly (after `~` expansion). It NEVER routes through a
 * homedir-fallback resolver, so when the worktree the conversation ran in has
 * been deleted, the stat misses → this returns null → the caller falls back to
 * the picker / direct launch. We never launch `--resume` from os.homedir()
 * unless the captured cwd genuinely IS the homedir.
 *
 * Returns `{ resumeUuid, claudeCwd }` only when ALL hold:
 *   - target present + has a uuid + a cwd;
 *   - the raw cwd (with `~` expanded) exists AND is a directory;
 *   - the transcript file `projectsRoot/<mangle(cwd)>/<uuid>.jsonl` exists.
 * Returns null on ANY miss or error (fail-open).
 *
 * The companion dir `projectsRoot/<mangle(cwd)>/<uuid>` is NO LONGER a
 * precondition: a direct-work conversation never got one from the CLI but is
 * still resumable, so we ENSURE it (best-effort, via deps.ensureCompanionDir)
 * after the transcript gate rather than gating on it.
 *
 * `claudeCwd` is the resolved (absolute, `~`-expanded) launch directory.
 */
export function resolveResumeLaunch(
  target: ResumeTarget | undefined,
  deps: ResolveResumeLaunchDeps,
): { resumeUuid: string; claudeCwd: string } | null {
  try {
    if (!target || !target.uuid || !target.cwd) return null

    // Defense-in-depth (FIX 4): re-validate the uuid against the canonical UUID
    // format BEFORE it is interpolated UNQUOTED into the spawn shell command. The
    // caller is expected to have validated already; this preserves the builder's
    // "caller validated" invariant and the fail-open rule even if it didn't.
    if (!UUID_RE.test(target.uuid)) return null

    const home = deps.homedir()

    // Expand a leading `~` ourselves (the OS does not on Windows). We do NOT
    // use resolveCwd(): it silently collapses a missing path to homedir, which
    // is exactly the bug this gate prevents.
    let expanded: string
    if (target.cwd === '~') {
      expanded = home
    } else if (target.cwd.startsWith('~/') || target.cwd.startsWith('~\\')) {
      expanded = nodePath.join(home, target.cwd.slice(2))
    } else {
      expanded = nodePath.resolve(target.cwd)
    }

    // Stat the RAW (expanded) cwd directly — the regression guard. A deleted
    // worktree misses here and we fall back; we never silently retarget homedir.
    if (!deps.existsSync(expanded)) return null
    if (!deps.statSync(expanded).isDirectory()) return null

    const projDir = nodePath.join(deps.projectsRoot, deps.mangleCwdToProjectDir(target.cwd))
    const transcriptPath = nodePath.join(projDir, `${target.uuid}.jsonl`)
    // The transcript MUST exist — without it there is no conversation to resume.
    if (!deps.existsSync(transcriptPath)) return null

    // The companion dir is NO LONGER a precondition. A conversation worked on
    // directly (no subagent/workflow) never got one from the CLI, yet it is a
    // real, resumable conversation. Ensure it exists (best-effort) so
    // `claude --resume` can find it. A failure here must NOT drop the resume —
    // the transcript is real; we still launch and let the CLI/fresh-fallback cope.
    try { deps.ensureCompanionDir(projDir, target.uuid) } catch { /* best-effort */ }

    return { resumeUuid: target.uuid, claudeCwd: expanded }
  } catch {
    // Fail-open: any unexpected error drops resume and falls back.
    return null
  }
}

// ---------------------------------------------------------------------------
// buildResumeTranscriptPath — deterministic resume-bind path (Part A)
// ---------------------------------------------------------------------------

/**
 * Construct the canonical transcript path for a KNOWN resume target so the
 * caller (pty-manager) can bind it IMMEDIATELY at spawn, without waiting for the
 * exact sources (hooks / statusline) or the heuristic fallback. This closes the
 * boot-time race that left the FIRST resumed session unbound (`nt=0`).
 *
 *   <homedir>/.claude/projects/<mangle(launchCwd)>/<uuid>.jsonl
 *
 * `launchCwd` must be the cwd the conversation ACTUALLY runs in (the
 * resolveResumeLaunch `claudeCwd`), since that is what Claude CLI mangles into
 * the project-folder name. The uuid is re-validated against the canonical UUID
 * format (defense-in-depth) — a non-UUID stem or empty cwd returns null so the
 * caller simply skips the deterministic bind (the heuristic still covers it).
 *
 * `homedir` is injectable for testing; production passes os.homedir.
 */
export function buildResumeTranscriptPath(
  launchCwd: string,
  uuid: string,
  homedir: () => string = () => nodeOs.homedir(),
): string | null {
  if (!launchCwd || !uuid || !UUID_RE.test(uuid)) return null
  return nodePath.join(homedir(), '.claude', 'projects', mangleCwdToProjectDir(launchCwd), `${uuid}.jsonl`)
}

export function buildClaudeLaunchCommand(opts: BuildClaudeLaunchCommandOptions): string {
  const { cwd, claudeBin, extraFlags, agentsFlag, useResumePicker, pickerScript, resumeUuid } = opts
  const isWin32 = opts.platform === 'win32'
  const escapedCwd = escapeForCwdQuote(cwd, isWin32)

  // RESUME path: bypass the picker, launch claude directly with --resume first.
  // The --resume verb must precede every other flag (resume-picker.js:299), so
  // it is injected before agentsFlag/extraFlags here.
  if (resumeUuid) {
    const resumeFlag = ` --resume ${resumeUuid}`
    return isWin32
      ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${resumeFlag}${agentsFlag}${extraFlags}; exit`
      : `cd '${escapedCwd}' && "${claudeBin}"${resumeFlag}${agentsFlag}${extraFlags}; exit`
  }

  // No-resume behaviour. P1.1: the picker-script branch forwards agentsFlag too
  // (it previously appended only extraFlags, silently dropping --agents on a
  // restored session). resume-picker.js forwards its own argv to
  // `claude --resume <id> ...`, so the flag survives the launch.
  if (useResumePicker) {
    if (pickerScript && isWin32) {
      const escapedScript = pickerScript.replace(/'/g, "''")
      return `Set-Location '${escapedCwd}'; node '${escapedScript}'${agentsFlag}${extraFlags}; exit`
    } else if (pickerScript) {
      return `cd '${escapedCwd}' && node '${pickerScript.replace(/'/g, "'\\''")}'${agentsFlag}${extraFlags}; exit`
    } else {
      // Fallback: no picker script found, launch Claude directly.
      return isWin32
        ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${agentsFlag}${extraFlags}; exit`
        : `cd '${escapedCwd}' && "${claudeBin}"${agentsFlag}${extraFlags}; exit`
    }
  }

  return isWin32
    ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${agentsFlag}${extraFlags}; exit`
    : `cd '${escapedCwd}' && "${claudeBin}"${agentsFlag}${extraFlags}; exit`
}
