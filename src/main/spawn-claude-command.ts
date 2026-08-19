/**
 * spawn-claude-command.ts — pure builder for the Claude launch command string.
 *
 * Extracted verbatim from pty-manager.ts's Claude branch (the shell command
 * written into the PTY after spawn) so it can be unit-tested WITHOUT node-pty /
 * Electron. No default export (project convention). No side effects.
 *
 * Behaviour contract:
 *   - When `resumeUuid` is ABSENT the produced string matches the pre-refactor
 *     inline construction (picker / picker-fallback / direct) EXCEPT for the
 *     binary and picker paths, which are now single-quoted rather than
 *     double-quoted. That is a deliberate security change, not drift: inside
 *     double quotes PowerShell expands `$(...)` and POSIX expands `$(...)` and
 *     backticks, and these values are PATHS whose contents a directory name
 *     decides. Byte-identity holds for every other part of the line.
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
import { askPromptRef } from './terminal-launch-line'

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
  /**
   * Ask Conductor: append Claude's opening prompt as a POSITIONAL argument,
   * passed by REFERENCE to the CCC_ASK_PROMPT env var (see askPromptRef). This
   * is a boolean, not the text: the question must never reach this builder as a
   * string, because anything that arrives here is interpolated into a line the
   * shell parses. Keeping the value out of the type makes that impossible to get
   * wrong rather than merely documented.
   *
   * Positional, so it goes AFTER every flag — `claude [options] [prompt]`.
   * Ignored on the resume path, which has a conversation to continue and no use
   * for an opening prompt.
   */
  askPrompt?: boolean
}

/**
 * Every character PowerShell accepts as a single-quote DELIMITER.
 *
 * PowerShell's tokenizer treats the ASCII apostrophe and four Unicode
 * quotation marks interchangeably: U+2018 LEFT, U+2019 RIGHT, U+201A LOW-9 and
 * U+201B HIGH-REVERSED-9. Escaping only U+0027 therefore leaves four ways to
 * terminate a quoted string early — and all four are legal in NTFS directory
 * names, so an ordinary folder name can carry one (a curly apostrophe is what
 * word processors produce, and those names get pasted into paths).
 *
 * POSIX shells have no equivalent: only U+0027 delimits there, which is why
 * the posix branch below is unchanged.
 */
const PS_SINGLE_QUOTE_CLASS = /[\u0027\u2018\u2019\u201A\u201B]/g

/**
 * Escape a path for single-quoting in the target shell.
 *   - win32 (PowerShell): double every single-quote delimiter (see above).
 *   - posix (sh): close-quote, backslash-escape, reopen-quote.
 *
 * Doubling is the correct escape for ALL of them: PowerShell reads a doubled
 * delimiter inside a single-quoted string as one literal character, whichever
 * of the five it is.
 */
function escapeForCwdQuote(p: string, isWin32: boolean): string {
  return isWin32 ? p.replace(PS_SINGLE_QUOTE_CLASS, (c) => c + c) : p.replace(/'/g, "'\\''")
}

/**
 * Single-quote an argument VALUE for the launch shell — returns the value
 * wrapped in single quotes, escaped for the target shell.
 *
 * Required for `--model` (#144): 1M-context model ids contain brackets
 * (`opus[1m]`), which zsh — the macOS default shell — parses as a glob
 * character class. Unquoted it fails with `zsh: no matches found: opus[1m]` and
 * aborts the ENTIRE launch line before claude/node ever runs, so no session
 * starts. bash and PowerShell pass the unmatched glob through literally, which
 * is why this only reproduces on zsh. Single quotes are literal in PowerShell
 * and POSIX sh/zsh alike.
 *
 * Pass `isWin32: false` for a command that will run on a REMOTE POSIX shell
 * (SSH sessions) regardless of the local platform.
 */
export function quoteArgForShell(value: string, isWin32: boolean): string {
  return `'${escapeForCwdQuote(value, isWin32)}'`
}

/**
 * Build the whole `--model <value>` flag, quoted, or '' when there is no model.
 *
 * Exists so the CALL SITES have nothing to get wrong. The #144 bug was not a
 * broken quoting helper -- there wasn't one -- it was two emission sites that
 * interpolated the raw value. A helper that returns only the escaped value
 * still lets a site write `--model ${options.model}` and typecheck cleanly,
 * which is exactly how the first regression guard for this bug turned out to be
 * vacuous (reverting both sites left the suite green). Returning the entire
 * flag removes that degree of freedom, and `checkedModelFlag` in
 * tests/unit/spawn-model-flag-quoting.test.ts asserts no site bypasses it.
 */
export function modelFlag(model: string | undefined | null, isWin32: boolean): string {
  if (!model) return ''
  return `--model ${quoteArgForShell(model, isWin32)}`
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
  // Positional opening prompt, by env reference — never the text itself.
  // Trailing position: `claude [options] [prompt]`.
  const promptArg = opts.askPrompt ? ` ${askPromptRef(isWin32)}` : ''
  const escapedCwd = escapeForCwdQuote(cwd, isWin32)
  // SINGLE-quoted, not double.
  //
  // `& "${claudeBin}"` looked safe because a binary path is not user text —
  // but it IS a path, and it comes from the resources directory or a `where`
  // lookup, so a directory name decides its contents. Inside DOUBLE quotes
  // both shells expand: PowerShell evaluates `$(...)` and POSIX evaluates
  // `$(...)` and backticks, at runtime, and both were verified executing.
  // Single quotes are literal in PowerShell and POSIX alike, and `& 'name'` /
  // `'name' args` still invoke a bare command name, a spaced path and an
  // absolute path exactly as before.
  const quotedBin = `'${escapeForCwdQuote(claudeBin, isWin32)}'`
  // Same shape of value (it also lives under the resources directory), and it
  // was being escaped by two hand-inlined copies of the helper — which is
  // precisely how it would have kept the old behaviour after the helper was
  // fixed. One helper, one call site each.
  const quotedPicker = pickerScript ? `'${escapeForCwdQuote(pickerScript, isWin32)}'` : null

  // RESUME path: bypass the picker, launch claude directly with --resume first.
  // The --resume verb must precede every other flag (resume-picker.js:299), so
  // it is injected before agentsFlag/extraFlags here.
  if (resumeUuid) {
    // Re-validated HERE, not trusted from the caller. The uuid is the one value
    // on this line that is interpolated UNQUOTED, and every current caller does
    // gate it with the same anchored regex — but "the caller checks" is a
    // comment, not a boundary, and this function is exported. Anchored, so a
    // uuid with a trailing `; …` is refused rather than launched.
    if (!UUID_RE.test(resumeUuid)) throw new Error('buildClaudeLaunchCommand: resumeUuid is not a uuid')
    const resumeFlag = ` --resume ${resumeUuid}`
    return isWin32
      ? `Set-Location '${escapedCwd}'; & ${quotedBin}${resumeFlag}${agentsFlag}${extraFlags}; exit`
      : `cd '${escapedCwd}' && ${quotedBin}${resumeFlag}${agentsFlag}${extraFlags}; exit`
  }

  // No-resume behaviour. P1.1: the picker-script branch forwards agentsFlag too
  // (it previously appended only extraFlags, silently dropping --agents on a
  // restored session). resume-picker.js forwards its own argv to
  // `claude --resume <id> ...`, so the flag survives the launch.
  if (useResumePicker) {
    if (quotedPicker) {
      return isWin32
        ? `Set-Location '${escapedCwd}'; node ${quotedPicker}${agentsFlag}${extraFlags}; exit`
        : `cd '${escapedCwd}' && node ${quotedPicker}${agentsFlag}${extraFlags}; exit`
    }
    // Fallback: no picker script found, launch Claude directly.
    return isWin32
      ? `Set-Location '${escapedCwd}'; & ${quotedBin}${agentsFlag}${extraFlags}; exit`
      : `cd '${escapedCwd}' && ${quotedBin}${agentsFlag}${extraFlags}; exit`
  }

  return isWin32
    ? `Set-Location '${escapedCwd}'; & ${quotedBin}${agentsFlag}${extraFlags}${promptArg}; exit`
    : `cd '${escapedCwd}' && ${quotedBin}${agentsFlag}${extraFlags}${promptArg}; exit`
}
